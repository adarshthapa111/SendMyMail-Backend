import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { requireAuth, requireClientScope, requireRole } from '../middleware/auth';
import { notFound, badRequest, conflict } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { launchCampaign } from '../campaigns/send';

/* /v1/clients/:clientId/campaigns — feature-campaigns V1.
   ──────────────────────────────────────────────────────────────
   The one-shot broadcast pipeline. Drafts live as Campaign rows with
   nullable envelope fields (subject / fromEmail / etc.) so the wizard
   can save progress one step at a time. Launch finalizes validation,
   snapshots recipients, and kicks off the synchronous send loop
   (see ../campaigns/send.ts).

   Endpoints:
     GET    /                  — list summaries (omits recipients)
     GET    /:id               — single campaign with full state
     POST   /         admin    — create draft (Step 1: just `name`)
     PATCH  /:id      admin    — update any field (each wizard step PATCHes)
     POST   /:id/launch admin  — validate + snapshot + start send loop
     DELETE /:id      admin    — soft-archive (only allowed when status: draft)
     GET    /:id/sends         — per-recipient send log (for report)
   ────────────────────────────────────────────────────────────── */

export const campaignsRouter = Router({ mergeParams: true });

/* ─── Helpers ────────────────────────────────────────────────────────────── */

const CAMPAIGN_FULL_SELECT = {
  id: true,
  agencyId: true,
  clientId: true,
  name: true,
  fromName: true,
  fromEmail: true,
  subject: true,
  preheader: true,
  templateId: true,
  listId: true,
  scheduleAt: true,
  status: true,
  recipientSnapshotAt: true,
  totalRecipients: true,
  sentCount: true,
  failedCount: true,
  archived: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
} as const;

const CAMPAIGN_SUMMARY_SELECT = {
  id: true,
  agencyId: true,
  clientId: true,
  name: true,
  templateId: true,
  listId: true,
  status: true,
  totalRecipients: true,
  sentCount: true,
  failedCount: true,
  scheduleAt: true,
  archived: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
} as const;

type CampaignFullRow = Prisma.CampaignGetPayload<{ select: typeof CAMPAIGN_FULL_SELECT }>;

async function assertClientExists(req: import('express').Request): Promise<string> {
  const clientId = String(req.params.clientId ?? '');
  const exists = await prisma.client.findFirst({
    where: { id: clientId, agencyId: req.auth!.agency_id, status: { not: 'archived' } },
    select: { id: true },
  });
  if (!exists) throw notFound();
  return clientId;
}

async function loadCampaignOr404(
  req: import('express').Request,
  campaignId: string,
): Promise<CampaignFullRow> {
  const clientId = String(req.params.clientId ?? '');
  const agencyId = req.auth!.agency_id;
  const row = await prisma.campaign.findFirst({
    where:  { id: campaignId, clientId, agencyId },
    select: CAMPAIGN_FULL_SELECT,
  });
  if (!row) throw notFound();
  return row;
}

/* ─── GET / — list ───────────────────────────────────────────────────────── */

const listQuery = z.object({
  includeArchived: z.coerce.boolean().optional().default(false),
  status:          z.enum(['draft', 'scheduled', 'sending', 'sent', 'failed']).optional(),
});

campaignsRouter.get('/', requireAuth(), requireClientScope, async (req, res, next) => {
  try {
    const { includeArchived, status } = listQuery.parse(req.query);
    await assertClientExists(req);
    const where: Prisma.CampaignWhereInput = {
      clientId: String(req.params.clientId ?? ''),
      agencyId: req.auth!.agency_id,
    };
    if (!includeArchived) where.archived = false;
    if (status)           where.status   = status;

    const rows = await prisma.campaign.findMany({
      where,
      select:  CAMPAIGN_SUMMARY_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: { items: rows } });
  } catch (err) {
    next(err);
  }
});

/* ─── GET /:id — single (full) ───────────────────────────────────────────── */

campaignsRouter.get('/:id', requireAuth(), requireClientScope, async (req, res, next) => {
  try {
    await assertClientExists(req);
    const row = await loadCampaignOr404(req, String(req.params.id ?? ''));
    const engagement = await computeEngagement(row.id, row.sentCount);
    res.json({ data: { campaign: { ...row, ...engagement } } });
  } catch (err) {
    next(err);
  }
});

/* Engagement aggregates — feature-engagement-tracking V1.
   Computed at request time from the Send aggregates (openCount / clickCount).
   Cheap: two COUNT queries on indexed columns + an optional GROUP BY for
   top links. Drafts skip everything (no Sends exist yet). */
interface EngagementStats {
  uniqueOpens:  number;          // Sends where firstOpenedAt is not null
  uniqueClicks: number;          // Sends where clickCount > 0
  openRate:     number | null;   // null when sentCount is 0
  clickRate:    number | null;
  topLinks:     Array<{ url: string; count: number }>;
}

async function computeEngagement(campaignId: string, sentCount: number): Promise<EngagementStats> {
  if (sentCount === 0) {
    return {
      uniqueOpens:  0,
      uniqueClicks: 0,
      openRate:     null,
      clickRate:    null,
      topLinks:     [],
    };
  }

  const [uniqueOpens, uniqueClicks] = await Promise.all([
    prisma.send.count({
      where: { campaignId, firstOpenedAt: { not: null } },
    }),
    prisma.send.count({
      where: { campaignId, clickCount: { gt: 0 } },
    }),
  ]);

  /* Top links: aggregate click events grouped by URL. Skip the query
     when uniqueClicks is 0 — no clicks means no URLs to surface. */
  let topLinks: Array<{ url: string; count: number }> = [];
  if (uniqueClicks > 0) {
    const grouped = await prisma.emailEvent.groupBy({
      by:       ['url'],
      where:    {
        send: { campaignId },
        type: 'click',
        url:  { not: null },
      },
      _count:   { _all: true },
      orderBy:  { _count: { id: 'desc' } },
      take:     10,
    });
    topLinks = grouped
      .filter((g) => g.url !== null)
      .map((g) => ({ url: g.url as string, count: g._count._all }));
  }

  return {
    uniqueOpens,
    uniqueClicks,
    openRate:  uniqueOpens  / sentCount,
    clickRate: uniqueClicks / sentCount,
    topLinks,
  };
}

/* ─── POST / — create draft (admin) ──────────────────────────────────────── */

const createBody = z.object({
  name: z.string().trim().min(1, 'Campaign name is required').max(200),
});

campaignsRouter.post('/', requireAuth(), requireRole('admin'), requireClientScope, async (req, res, next) => {
  try {
    const body = createBody.parse(req.body);
    await assertClientExists(req);
    const agencyId = req.auth!.agency_id;
    const userId   = req.auth!.sub;
    const clientId = String(req.params.clientId ?? '');

    const created = await prisma.campaign.create({
      data: {
        agencyId,
        clientId,
        name:      body.name,
        createdBy: userId,
      },
      select: CAMPAIGN_FULL_SELECT,
    });

    writeAudit({
      agencyId,
      actorUserId: userId,
      action:      'campaign.created',
      targetType:  'campaign',
      targetId:    created.id,
      metadata:    { clientId, name: created.name },
      req,
    });

    res.status(201).json({ data: { campaign: created } });
  } catch (err) {
    next(err);
  }
});

/* ─── PATCH /:id — update draft (admin) ──────────────────────────────────── */

/* All wizard fields nullable on PATCH so each step can update incrementally.
   Server-side validation enforces formats; required-field checks happen at
   launch time (so the user can save a partial draft and come back to it). */
const updateBody = z.object({
  name:       z.string().trim().min(1).max(200).optional(),
  fromName:   z.string().trim().min(1).max(100).nullable().optional(),
  fromEmail:  z.email({ message: 'Must be a valid email' }).nullable().optional(),
  subject:    z.string().trim().min(1).max(200).nullable().optional(),
  preheader:  z.string().trim().max(150).nullable().optional(),
  templateId: z.string().nullable().optional(),
  listId:     z.string().nullable().optional(),
  archived:   z.boolean().optional(),
}).strict();

campaignsRouter.patch('/:id', requireAuth(), requireRole('admin'), requireClientScope, async (req, res, next) => {
  try {
    const body = updateBody.parse(req.body);
    await assertClientExists(req);
    const existing = await loadCampaignOr404(req, String(req.params.id ?? ''));

    if (existing.status === 'sent' || existing.status === 'sending') {
      return next(conflict('cannot_edit_sent', 'Sent or in-flight campaigns cannot be edited.'));
    }

    /* If templateId is being set, verify it belongs to the same client. */
    if (body.templateId !== undefined && body.templateId !== null) {
      const tpl = await prisma.template.findFirst({
        where: {
          id:       body.templateId,
          clientId: existing.clientId,
          archived: false,
        },
        select: { id: true },
      });
      if (!tpl) return next(badRequest('invalid_template', 'Template not found or archived.', { field: 'templateId' }));
    }

    /* Same check for listId. */
    if (body.listId !== undefined && body.listId !== null) {
      const list = await prisma.list.findFirst({
        where: {
          id:       body.listId,
          clientId: existing.clientId,
          archived: false,
        },
        select: { id: true },
      });
      if (!list) return next(badRequest('invalid_list', 'List not found or archived.', { field: 'listId' }));
    }

    const agencyId = req.auth!.agency_id;
    const userId   = req.auth!.sub;

    const updated = await prisma.campaign.update({
      where:  { id: existing.id },
      data:   body,
      select: CAMPAIGN_FULL_SELECT,
    });

    writeAudit({
      agencyId,
      actorUserId: userId,
      action:      'campaign.updated',
      targetType:  'campaign',
      targetId:    updated.id,
      metadata:    { fields: Object.keys(body) },
      req,
    });

    res.json({ data: { campaign: updated } });
  } catch (err) {
    next(err);
  }
});

/* ─── DELETE /:id — soft-archive draft (admin) ───────────────────────────── */

campaignsRouter.delete('/:id', requireAuth(), requireRole('admin'), requireClientScope, async (req, res, next) => {
  try {
    await assertClientExists(req);
    const existing = await loadCampaignOr404(req, String(req.params.id ?? ''));

    if (existing.status !== 'draft') {
      return next(conflict('cannot_delete', 'Only draft campaigns can be deleted.'));
    }
    if (existing.archived) {
      // Idempotent — already archived
      return res.status(204).end();
    }

    await prisma.campaign.update({
      where: { id: existing.id },
      data:  { archived: true },
    });

    writeAudit({
      agencyId:    existing.agencyId,
      actorUserId: req.auth!.sub,
      action:      'campaign.deleted',
      targetType:  'campaign',
      targetId:    existing.id,
      req,
    });

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/* ─── POST /:id/launch — snapshot + send (admin) ─────────────────────────── */

campaignsRouter.post('/:id/launch', requireAuth(), requireRole('admin'), requireClientScope, async (req, res, next) => {
  try {
    await assertClientExists(req);
    const existing = await loadCampaignOr404(req, String(req.params.id ?? ''));
    const userId   = req.auth!.sub;

    const result = await launchCampaign(existing.id, userId);

    if (!result.ok) {
      switch (result.error.code) {
        case 'not_found':
          return next(notFound());
        case 'already_launched':
          return next(conflict('already_launched', 'Campaign has already been launched.'));
        case 'incomplete':
          return next(badRequest(
            'incomplete',
            `Campaign is missing required field: ${result.error.field}`,
            { field: result.error.field },
          ));
        case 'no_recipients':
          return next(badRequest('no_recipients', 'List has no subscribed contacts.'));
      }
    }

    // Re-fetch to return the latest state (status: 'sending', recipientSnapshotAt set)
    const fresh = await loadCampaignOr404(req, existing.id);
    res.json({ data: { campaign: fresh } });
  } catch (err) {
    next(err);
  }
});

/* ─── GET /:id/sends — per-recipient send log ───────────────────────────── */

const sendsQuery = z.object({
  cursor: z.string().optional(),
  limit:  z.coerce.number().int().min(1).max(200).optional().default(50),
});

campaignsRouter.get('/:id/sends', requireAuth(), requireClientScope, async (req, res, next) => {
  try {
    const { cursor, limit } = sendsQuery.parse(req.query);
    await assertClientExists(req);
    const existing = await loadCampaignOr404(req, String(req.params.id ?? ''));

    const rows = await prisma.send.findMany({
      where:    { campaignId: existing.id },
      take:     limit + 1,                  // overfetch by 1 to detect "has more"
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy:  { createdAt: 'desc' },
    });

    const hasMore   = rows.length > limit;
    const sends     = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? sends[sends.length - 1].id : null;

    res.json({ data: { sends, nextCursor } });
  } catch (err) {
    next(err);
  }
});
