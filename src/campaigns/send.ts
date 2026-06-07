/**
 * Campaign send pipeline — synchronous, in-process, rate-limited.
 *
 * Architecture (V1):
 *   POST /campaigns/:id/launch handler →
 *     1. LOCK + transition campaign to 'sending'
 *     2. SNAPSHOT recipients from the list into campaign_recipients
 *     3. LOAD suppression list (agency-wide)
 *     4. RESOLVE FROM address (verified sending domain if available)
 *     5. RENDER template once via mjml2htmlProcessed
 *     6. LOOP per recipient: skip if suppressed, else merge tags +
 *        inject unsubscribe footer if missing → sendRawHtml → write
 *        Send row
 *     7. FINALIZE counts + status
 *
 * Why synchronous (not BullMQ V1): most agency campaigns ≤500 recipients.
 * ~220ms between sends = ~110s loop = well within an Express request
 * handler's lifetime. The handler RESPONDS to the caller after step 2
 * (snapshot done) and step 3-7 continue in the background of the same
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
import {
  applyMergeTags,
  applyMergeTagsSubject,
  injectUnsubscribeFooter,
} from './merge';
import { injectTracking } from './html-tracking';
import { signUnsubToken } from '../lib/unsubscribe-token';
import { findVerifiedDomain } from '../lib/sending-domain';

/* Rate limit: Resend's free-tier ceiling is 5 req/sec. 220ms = ~4.5 req/sec
   stays safely under. The earlier 170ms (~5.88 req/sec) tripped 429s on
   campaigns >50 recipients. Adds ~30% to total loop time on large sends
   but keeps the API happy. */
const SEND_RATE_MS = 220;
const COUNTER_FLUSH_EVERY = 25;       // update campaign.sentCount / failedCount every N sends

const APP_URL = process.env.APP_URL || 'http://localhost:5173';

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

  /* 2. Snapshot recipients. */
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
      skipDuplicates: true,
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

  /* Background send loop. */
  void runSendLoop(campaignId, actorUserId);

  return { ok: true, totalRecipients: contacts.length };
}

/**
 * The send loop. Runs in the background after launchCampaign returns.
 * Each per-recipient try/catch keeps one bad email from breaking the
 * whole loop. The outer try/catch handles unhandled throws (DB outage,
 * etc.) by best-effort marking the campaign 'failed' so it doesn't sit
 * in 'sending' forever.
 */
async function runSendLoop(campaignId: string, actorUserId: string): Promise<void> {
  try {
    const campaign = await prisma.campaign.findUnique({
      where:  { id: campaignId },
      select: {
        agencyId:   true,
        subject:    true,
        fromEmail:  true,
        fromName:   true,
        templateId: true,
        listId:     true,
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

    /* ── Load agency context for FROM resolution + suppression check ── */

    const agency = await prisma.agency.findUnique({
      where:  { id: campaign.agencyId },
      select: { name: true },
    });
    const agencyName = agency?.name ?? 'SendMyMail';

    const verifiedDomain = await findVerifiedDomain(campaign.agencyId);
    const fromOverride = verifiedDomain
      ? `${agencyName} <campaigns@${verifiedDomain.name}>`
      : undefined;

    /* Load suppression list once, keep as a Set for O(1) lookup.
       Memory: ~10 KB per 1000 entries. Safe up to ~100K entries
       before we'd want a more efficient structure. */
    const suppressed = await prisma.suppression.findMany({
      where:  { agencyId: campaign.agencyId },
      select: { email: true },
    });
    const suppressionSet = new Set(suppressed.map((s) => s.email.toLowerCase()));

    /* ── Iterate recipients ─────────────────────────────────────────── */

    const recipients = await prisma.campaignRecipient.findMany({
      where:   { campaignId },
      orderBy: { email: 'asc' },          // deterministic ordering for resumability later
    });

    let sentCount   = 0;
    let failedCount = 0;

    for (const recipient of recipients) {
      /* SUPPRESSION CHECK — skip without calling Resend. Record as
         failed in the Send table so the report shows what happened. */
      if (suppressionSet.has(recipient.email.toLowerCase())) {
        await prisma.send.create({
          data: {
            campaignId,
            toEmail:         recipient.email,
            resendMessageId: null,
            status:          'failed',
            error:           'Recipient is in agency suppression list',
            sentAt:          null,
          },
        });
        failedCount++;
        continue;                          // NO sleep — we didn't hit Resend
      }

      /* UNSUBSCRIBE TOKEN (per-recipient) */
      const unsubToken = signUnsubToken({
        contactId: recipient.contactId ?? '',
        listId:    campaign.listId ?? '',
        agencyId:  campaign.agencyId,
      });
      const unsubUrl = `${APP_URL}/u/${unsubToken}`;

      const mergeValues = {
        first_name:      recipient.firstName ?? '',
        last_name:       recipient.lastName ?? '',
        email:           recipient.email,
        unsubscribe_url: unsubUrl,
      };

      /* HTML body: substitute placeholders + inject footer if no
         {{unsubscribe_url}} was in the template. */
      let html = applyMergeTags(baseHtml, mergeValues);
      html = injectUnsubscribeFooter(html, unsubUrl, agencyName);

      /* Subject: substitute first_name / last_name / email (NOT
         unsubscribe_url — applyMergeTagsSubject strips it). */
      const subject = applyMergeTagsSubject(campaign.subject, mergeValues);

      /* INSERT Send row BEFORE sendRawHtml so we have a sendId to
         use for engagement tracking tokens. Status starts as 'queued'
         (a SendStatus enum value reserved exactly for this transition);
         we UPDATE to 'sent' or 'failed' after Resend returns. */
      const sendRow = await prisma.send.create({
        data: {
          campaignId,
          toEmail: recipient.email,
          status:  'queued',
        },
        select: { id: true },
      });

      /* Engagement tracking: rewrite hrefs through /e/c/{token} and
         inject a 1×1 tracking pixel before </body>. Tokens sign with
         this Send's id so events route back to the right row. */
      html = injectTracking(html, sendRow.id);

      let resendMessageId: string | undefined;
      let sendStatus: 'sent' | 'failed' = 'sent';
      let errorReason: string | undefined;

      try {
        const result = await sendRawHtml({
          to:              recipient.email,
          subject,
          html,
          from:            fromOverride,                                 // verified domain when available
          replyTo:         campaign.fromEmail ?? undefined,
          listUnsubscribe: `<${unsubUrl}>`,                              // Gmail bulk-sender requirement
        });
        resendMessageId = result.messageId;
        sentCount++;
      } catch (err) {
        sendStatus  = 'failed';
        errorReason = err instanceof Error ? err.message : String(err);
        failedCount++;
      }

      await prisma.send.update({
        where: { id: sendRow.id },
        data: {
          resendMessageId,
          status: sendStatus,
          error:  errorReason,
          sentAt: sendStatus === 'sent' ? new Date() : null,
        },
      });

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
      metadata:    {
        sentCount,
        failedCount,
        totalRecipients:    recipients.length,
        usedVerifiedDomain: !!verifiedDomain,
      },
    });
  } catch (err) {
    console.error(`[send-loop] unhandled error in campaign ${campaignId}:`, err);
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
