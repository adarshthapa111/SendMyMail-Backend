/**
 * Campaign send pipeline — synchronous, in-process, rate-limited.
 *
 * Architecture (V1):
 *   POST /campaigns/:id/launch handler →
 *     1. LOCK + transition campaign to 'sending'
 *     2. SNAPSHOT recipients from the list into campaign_recipients
 *     3. RENDER template once via mjml2htmlProcessed
 *     4. LOOP per recipient: merge tags → sendRawHtml → write Send row
 *     5. FINALIZE counts + status
 *
 * Why synchronous (not BullMQ V1): most agency campaigns ≤500 recipients.
 * ~170ms between sends = ~85s loop = well within an Express request
 * handler's lifetime. The handler RESPONDS to the caller after step 2
 * (snapshot done) and step 3-5 continue in the background of the same
 * Node.js event loop. The frontend polls GET /campaigns/:id every 5s
 * to track progress.
 *
 * Forward-compat: when V2 adds BullMQ, the body of launchCampaign moves
 * into a worker; the route handler instead enqueues a job. The function
 * shape stays the same.
 */

import { prisma } from '../lib/prisma';
import { mjml2htmlProcessed } from '../mjml/mjmlWrapper';
import { sendRawHtml } from '../lib/email';
import { writeAudit } from '../lib/audit';
import { applyMergeTags } from './merge';

const SEND_RATE_MS = 170;             // ~6 req/sec — under Resend's 10/sec free-tier ceiling
const COUNTER_FLUSH_EVERY = 25;       // update campaign.sentCount / failedCount every N sends

type LaunchError =
  | { code: 'not_found' }
  | { code: 'already_launched' }
  | { code: 'incomplete'; field: string }
  | { code: 'no_recipients' };

interface LaunchOk {
  ok: true;
  totalRecipients: number;
}

interface LaunchFail {
  ok: false;
  error: LaunchError;
}

export type LaunchResult = LaunchOk | LaunchFail;

/**
 * Prepares the campaign for sending: validates → flips status → snapshots
 * recipients. Returns synchronously. The actual send loop runs in the
 * background — the caller doesn't await it. The caller awaits this
 * function, which only completes after the snapshot is durable.
 *
 * The "fire-and-forget" pattern: we schedule the send loop with
 * `void runSendLoop(...)` after responding to the HTTP request. Node.js
 * keeps the event loop alive until the loop completes.
 */
export async function launchCampaign(
  campaignId: string,
  actorUserId: string,
): Promise<LaunchResult> {
  /* 1. Lock + validate + transition */
  const campaign = await prisma.$transaction(async (tx) => {
    const row = await tx.campaign.findUnique({ where: { id: campaignId } });
    if (!row) return { kind: 'not_found' as const };
    if (row.status !== 'draft' && row.status !== 'scheduled') {
      return { kind: 'already_launched' as const };
    }
    if (!row.fromEmail) return { kind: 'incomplete' as const, field: 'fromEmail' };
    if (!row.subject)   return { kind: 'incomplete' as const, field: 'subject' };
    if (!row.templateId) return { kind: 'incomplete' as const, field: 'templateId' };
    if (!row.listId)     return { kind: 'incomplete' as const, field: 'listId' };

    const updated = await tx.campaign.update({
      where: { id: campaignId },
      data:  { status: 'sending' },
    });
    return { kind: 'ok' as const, row: updated };
  });

  if (campaign.kind === 'not_found')        return { ok: false, error: { code: 'not_found' } };
  if (campaign.kind === 'already_launched') return { ok: false, error: { code: 'already_launched' } };
  if (campaign.kind === 'incomplete') {
    return { ok: false, error: { code: 'incomplete', field: campaign.field } };
  }

  const row = campaign.row;

  /* 2. Snapshot recipients from the list.
        Filters: contact not soft-deleted; list membership status active.
        We accept a tiny race here — a contact added/removed in the
        microseconds between the SELECT and the createMany doesn't matter
        for V1; for V2 we may wrap this in an advisory lock. */
  const contacts = await prisma.contact.findMany({
    where: {
      clientId: row.clientId,
      deletedAt: null,
      listMembers: {
        some: { listId: row.listId!, status: 'subscribed' },
      },
    },
    select: { id: true, email: true, firstName: true, lastName: true },
  });

  if (contacts.length === 0) {
    // Roll the campaign back to draft so the user can fix the list.
    await prisma.campaign.update({
      where: { id: campaignId },
      data:  { status: 'draft' },
    });
    return { ok: false, error: { code: 'no_recipients' } };
  }

  await prisma.$transaction([
    prisma.campaignRecipient.createMany({
      data: contacts.map((c) => ({
        campaignId,
        contactId: c.id,
        email:     c.email,
        firstName: c.firstName,
        lastName:  c.lastName,
      })),
      skipDuplicates: true,                // composite-PK collisions are fine
    }),
    prisma.campaign.update({
      where: { id: campaignId },
      data: {
        recipientSnapshotAt: new Date(),
        totalRecipients:     contacts.length,
      },
    }),
  ]);

  writeAudit({
    agencyId:    row.agencyId,
    actorUserId,
    action:      'campaign.launched',
    targetType:  'campaign',
    targetId:    campaignId,
    metadata:    { totalRecipients: contacts.length, listId: row.listId, templateId: row.templateId },
  });

  /* 3-5. Background send loop. void = no await; the HTTP handler
          returns immediately. Node.js keeps the process alive until
          the loop drains. */
  void runSendLoop(campaignId, actorUserId);

  return { ok: true, totalRecipients: contacts.length };
}

/**
 * The send loop. Runs in the background after launchCampaign returns.
 * Crashes here don't propagate — they're caught and logged so a single
 * bad recipient doesn't break the loop. The campaign ends up in 'sent'
 * (if ≥1 succeeded) or 'failed' (if all failed).
 */
async function runSendLoop(campaignId: string, actorUserId: string): Promise<void> {
  try {
    const campaign = await prisma.campaign.findUnique({
      where:  { id: campaignId },
      select: {
        agencyId: true,
        subject: true,
        fromEmail: true,
        fromName: true,
        templateId: true,
      },
    });
    if (!campaign || !campaign.templateId || !campaign.subject) {
      console.error(`[send-loop] campaign ${campaignId} disappeared or missing required fields`);
      return;
    }

    const template = await prisma.template.findUnique({
      where:  { id: campaign.templateId },
      select: { mjmlSource: true },
    });
    if (!template) {
      console.error(`[send-loop] template for campaign ${campaignId} disappeared`);
      await prisma.campaign.update({
        where: { id: campaignId },
        data:  { status: 'failed' },
      });
      return;
    }

    const compiled = mjml2htmlProcessed(template.mjmlSource);
    if (!compiled.html) {
      console.error(`[send-loop] template did not compile for campaign ${campaignId}`);
      await prisma.campaign.update({
        where: { id: campaignId },
        data:  { status: 'failed' },
      });
      return;
    }
    const baseHtml = compiled.html;

    const recipients = await prisma.campaignRecipient.findMany({
      where:   { campaignId },
      orderBy: { email: 'asc' },          // deterministic ordering for resumability later
    });

    let sentCount   = 0;
    let failedCount = 0;

    for (const recipient of recipients) {
      const html = applyMergeTags(baseHtml, {
        first_name: recipient.firstName ?? '',
        last_name:  recipient.lastName ?? '',
        email:      recipient.email,
      });

      let resendMessageId: string | undefined;
      let sendStatus: 'sent' | 'failed' = 'sent';
      let errorReason: string | undefined;

      try {
        const result = await sendRawHtml({
          to:      recipient.email,
          subject: campaign.subject,
          html,
          replyTo: campaign.fromEmail ?? undefined,
        });
        resendMessageId = result.messageId;
        sentCount++;
      } catch (err) {
        sendStatus  = 'failed';
        errorReason = err instanceof Error ? err.message : String(err);
        failedCount++;
      }

      await prisma.send.create({
        data: {
          campaignId,
          toEmail:         recipient.email,
          resendMessageId,
          status:          sendStatus,
          error:           errorReason,
          sentAt:          sendStatus === 'sent' ? new Date() : null,
        },
      });

      // Flush counters periodically so the polling report sees progress
      if ((sentCount + failedCount) % COUNTER_FLUSH_EVERY === 0) {
        await prisma.campaign.update({
          where: { id: campaignId },
          data:  { sentCount, failedCount },
        });
      }

      await sleep(SEND_RATE_MS);
    }

    /* Finalize */
    await prisma.campaign.update({
      where: { id: campaignId },
      data: {
        sentCount,
        failedCount,
        status: sentCount > 0 ? 'sent' : 'failed',
      },
    });

    writeAudit({
      agencyId:    campaign.agencyId,
      actorUserId,
      action:      'campaign.send_completed',
      targetType:  'campaign',
      targetId:    campaignId,
      metadata:    { sentCount, failedCount, totalRecipients: recipients.length },
    });
  } catch (err) {
    console.error(`[send-loop] unhandled error in campaign ${campaignId}:`, err);
    // Best-effort mark failed so it's not stuck in 'sending'
    try {
      await prisma.campaign.update({
        where: { id: campaignId },
        data:  { status: 'failed' },
      });
    } catch {
      // Swallow — the outer error is already logged
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
