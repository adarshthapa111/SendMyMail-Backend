import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { requireAuth, requireRole } from '../middleware/auth';
import { notFound, conflict } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { slugFromName } from '../lib/slug';
import { invalidateOverview } from '../lib/overview';
import {
  aggregateSends, dailyChart, topCampaignsByEngagement, listGrowth,
  subDaysUtc,
} from '../lib/report';

/* /v1/clients — full CRUD for clients (feature-client-management).
   READ:    GET /          (list)
            GET /:id       (single)
   WRITE:   POST /         (create)            owner/admin
            PATCH /:id     (update)            owner/admin
            DELETE /:id    (soft-archive)      owner/admin

   Slugs are always server-generated from the name. On collision, return
   `409 name_taken` referencing the *name* field — the user never sees the
   slug, so an honest "this name is taken" message beats a silent retry. */

export const clientsRouter = Router();

/* The shape every endpoint returns — keeps the response shape consistent
   across list, get-by-id, create, update, and archive. */
const CLIENT_SELECT = {
  id: true,
  name: true,
  slug: true,
  domain: true,
  avatarColor: true,
  status: true,
  createdAt: true,
} as const;

type ClientRow = Prisma.ClientGetPayload<{ select: typeof CLIENT_SELECT }>;

function serialize(c: ClientRow) {
  return {
    id: c.id,
    name: c.name,
    slug: c.slug,
    domain: c.domain,
    avatarColor: c.avatarColor,
    status: c.status,
    createdAt: c.createdAt.toISOString(),
  };
}

/* Throws `404 not_found` if the client isn't in the caller's agency OR isn't
   in their UserClientScope (when scope.type === 'clients'). Same 404-not-403
   trick used by requireClientScope — never leak that the resource exists. */
async function loadClientOr404(req: import('express').Request, id: string): Promise<ClientRow> {
  const agencyId = req.auth!.agency_id;
  const scope    = req.auth!.scope;
  if (scope.type === 'clients' && !scope.ids.includes(id)) {
    throw notFound();
  }
  const row = await prisma.client.findFirst({
    where: { id, agencyId },
    select: CLIENT_SELECT,
  });
  if (!row) throw notFound();
  return row;
}

/* ─── GET /v1/clients — list ─────────────────────────────────────────────── */

clientsRouter.get('/', requireAuth(), async (req, res, next) => {
  try {
    const agencyId = req.auth!.agency_id;
    const scope    = req.auth!.scope;
    /* `?includeArchived=true` opts archived clients INTO the result. Default
       behavior is unchanged — active/trial/paused only. The FE asks for
       everything so users can browse the Archived tab without a re-fetch. */
    const includeArchived = req.query.includeArchived === 'true' || req.query.includeArchived === '1';

    const where = {
      agencyId,
      ...(includeArchived ? {} : { status: { not: 'archived' as const } }),
      ...(scope.type === 'clients' ? { id: { in: scope.ids } } : {}),
    };

    const rows = await prisma.client.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: CLIENT_SELECT,
    });

    res.json({ data: { items: rows.map(serialize) } });
  } catch (err) {
    next(err);
  }
});

/* ─── GET /v1/clients/:id — single ───────────────────────────────────────── */

clientsRouter.get('/:id', requireAuth(), async (req, res, next) => {
  try {
    const id = String(req.params.id ?? '');
    const row = await loadClientOr404(req, id);
    res.json({ data: { client: serialize(row) } });
  } catch (err) {
    next(err);
  }
});

/* ─── POST /v1/clients — create ──────────────────────────────────────────── */

const createBody = z.object({
  name:        z.string().trim().min(1).max(100),
  domain:      z.string().trim().min(1).max(253).nullish(),
  avatarColor: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'invalid_color').nullish(),
});

clientsRouter.post('/', requireAuth(), requireRole('admin'), async (req, res, next) => {
  try {
    const body     = createBody.parse(req.body);
    const agencyId = req.auth!.agency_id;
    const userId   = req.auth!.sub;
    const slug     = slugFromName(body.name);

    let row: ClientRow;
    try {
      row = await prisma.client.create({
        data: {
          agencyId,
          name:        body.name,
          slug,
          domain:      body.domain ?? null,
          avatarColor: body.avatarColor ?? null,
          status:      'active',
        },
        select: CLIENT_SELECT,
      });
    } catch (err) {
      // Postgres unique-constraint violation on (agency_id, slug)
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw conflict(
          'name_taken',
          'A client with this name already exists — try a different name.',
          { field: 'name' },
        );
      }
      throw err;
    }

    writeAudit({
      agencyId,
      actorUserId: userId,
      action:      'client.created',
      targetType:  'client',
      targetId:    row.id,
      metadata:    { name: row.name, slug: row.slug },
      req,
    });
    invalidateOverview(agencyId);   // dashboard's active-clients count + top-list need to reflect this

    res.status(201).json({ data: { client: serialize(row) } });
  } catch (err) {
    next(err);
  }
});

/* ─── PATCH /v1/clients/:id — update ─────────────────────────────────────── */

const updateBody = z.object({
  name:        z.string().trim().min(1).max(100).optional(),
  domain:      z.string().trim().min(1).max(253).nullish(),
  avatarColor: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'invalid_color').nullish(),
  /* Status is only here to support "restore" — flipping an archived client
     back to active. Other transitions (active → paused etc.) aren't surfaced
     in V1; the only callers are the FE restore button. */
  status:      z.enum(['trial', 'active', 'paused']).optional(),
}).strict();      // reject unknown keys (including slug)

clientsRouter.patch('/:id', requireAuth(), requireRole('admin'), async (req, res, next) => {
  try {
    const id     = String(req.params.id ?? '');
    const body   = updateBody.parse(req.body);
    const before = await loadClientOr404(req, id);

    const data: Prisma.ClientUpdateInput = {};
    if (body.name !== undefined)        data.name        = body.name;
    if (body.domain !== undefined)      data.domain      = body.domain ?? null;
    if (body.avatarColor !== undefined) data.avatarColor = body.avatarColor ?? null;
    if (body.status !== undefined)      data.status      = body.status;

    const row = await prisma.client.update({
      where: { id },
      data,
      select: CLIENT_SELECT,
    });

    const changes: Prisma.InputJsonValue = {};
    for (const key of ['name', 'domain', 'avatarColor', 'status'] as const) {
      if (before[key] !== row[key]) {
        (changes as Record<string, Prisma.InputJsonValue>)[key] = {
          from: before[key] ?? null,
          to:   row[key]    ?? null,
        };
      }
    }
    writeAudit({
      agencyId:    req.auth!.agency_id,
      actorUserId: req.auth!.sub,
      action:      'client.updated',
      targetType:  'client',
      targetId:    row.id,
      metadata:    { changes },
      req,
    });
    invalidateOverview(req.auth!.agency_id);   // top_clients ordering / name shown on dashboard may have changed

    res.json({ data: { client: serialize(row) } });
  } catch (err) {
    next(err);
  }
});

/* ─── DELETE /v1/clients/:id — soft-archive ──────────────────────────────── */

clientsRouter.delete('/:id', requireAuth(), requireRole('admin'), async (req, res, next) => {
  try {
    const id  = String(req.params.id ?? '');
    const row = await loadClientOr404(req, id);

    // Idempotent — re-archiving an already-archived client is a no-op (returns the row).
    let archived = row;
    if (row.status !== 'archived') {
      archived = await prisma.client.update({
        where: { id },
        data: { status: 'archived' },
        select: CLIENT_SELECT,
      });
      writeAudit({
        agencyId:    req.auth!.agency_id,
        actorUserId: req.auth!.sub,
        action:      'client.archived',
        targetType:  'client',
        targetId:    archived.id,
        metadata:    { name: archived.name },
        req,
      });
      invalidateOverview(req.auth!.agency_id);   // active-clients count + top_clients change
    }

    res.json({ data: { client: serialize(archived) } });
  } catch (err) {
    next(err);
  }
});

/* ─── GET /:id/report — per-client engagement report ──────────────────────
   feature-reports V1. Cached 60s in-process per (clientId, range).
   Returns the same shape regardless of range — the frontend re-renders
   on range change.

   range: 30d (default) | 90d | all */

const REPORT_TTL_MS = 60_000;
const reportCache = new Map<string, { payload: ClientReportPayload; expiresAt: number }>();
const MAX_REPORT_CACHE_ENTRIES = 1_000;

function reportCacheKey(clientId: string, range: string): string {
  return `${clientId}:${range}`;
}

function trimReportCacheIfFull(): void {
  if (reportCache.size < MAX_REPORT_CACHE_ENTRIES) return;
  const drop = Math.ceil(MAX_REPORT_CACHE_ENTRIES * 0.1);
  let dropped = 0;
  for (const key of reportCache.keys()) {
    if (dropped >= drop) break;
    reportCache.delete(key);
    dropped++;
  }
}

const reportQuery = z.object({
  range: z.enum(['30d', '90d', 'all']).optional().default('30d'),
});

interface ClientReportPayload {
  client: { id: string; name: string };
  range:  '30d' | '90d' | 'all';
  kpis: {
    sent_count:    number;
    unique_opens:  number;
    unique_clicks: number;
    open_rate:     number | null;
    click_rate:    number | null;
    list_growth:   number;          // added - unsubscribed
  };
  sending_chart: Array<{ date_iso: string; sent: number; opened: number }>;
  top_campaigns: Array<{
    id:         string;
    name:       string;
    subject:    string | null;
    sent_at:    string | null;
    sent_count: number;
    open_rate:  number | null;
    click_rate: number | null;
  }>;
  list_health: {
    total_contacts:     number;
    subscribed_count:   number;
    unsubscribed_count: number;
    suppressed_count:   number;
  };
}

clientsRouter.get('/:id/report', requireAuth(), async (req, res, next) => {
  try {
    const { range } = reportQuery.parse(req.query);
    const clientId  = String(req.params.id ?? '');
    const agencyId  = req.auth!.agency_id;

    /* Scope check — member-scoped users can only read their accessible
       clients' reports. */
    const scope = req.auth!.scope;
    if (scope.type === 'clients' && !scope.ids.includes(clientId)) {
      throw notFound();
    }

    const client = await prisma.client.findFirst({
      where:  { id: clientId, agencyId, status: { not: 'archived' } },
      select: { id: true, name: true },
    });
    if (!client) throw notFound();

    /* Cache check. */
    const cacheKey = reportCacheKey(clientId, range);
    const cached   = reportCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json({ data: cached.payload });
    }

    /* Compute date range. "all" maps to a very old startAt — Postgres
       handles the unbounded range fine on indexed columns. */
    const now      = new Date();
    const startAt  = range === '30d' ? subDaysUtc(now, 30)
                   : range === '90d' ? subDaysUtc(now, 90)
                   : new Date('2000-01-01T00:00:00Z');
    const endAt    = now;

    const aggBase = { agencyId, clientIds: [clientId], startAt, endAt };

    const [agg, chart, top, growth, listHealth] = await Promise.all([
      aggregateSends(aggBase),
      dailyChart(aggBase),
      topCampaignsByEngagement({ ...aggBase, limit: 5 }),
      listGrowth(aggBase),
      computeListHealth(clientId, agencyId),
    ]);

    const payload: ClientReportPayload = {
      client: { id: client.id, name: client.name },
      range,
      kpis: {
        sent_count:    agg.sentCount,
        unique_opens:  agg.uniqueOpens,
        unique_clicks: agg.uniqueClicks,
        open_rate:     agg.openRate,
        click_rate:    agg.clickRate,
        list_growth:   growth.added - growth.unsubscribed,
      },
      sending_chart: chart,
      top_campaigns: top.map((c) => ({
        id:         c.id,
        name:       c.name,
        subject:    c.subject,
        sent_at:    c.sentAt,
        sent_count: c.sentCount,
        open_rate:  c.openRate,
        click_rate: c.clickRate,
      })),
      list_health: listHealth,
    };

    trimReportCacheIfFull();
    reportCache.set(cacheKey, { payload, expiresAt: Date.now() + REPORT_TTL_MS });

    res.json({ data: payload });
  } catch (err) {
    next(err);
  }
});

/* ─── List health snapshot (point-in-time, not range-scoped) ─────────── */

async function computeListHealth(clientId: string, agencyId: string): Promise<{
  total_contacts:     number;
  subscribed_count:   number;
  unsubscribed_count: number;
  suppressed_count:   number;
}> {
  /* total_contacts = non-deleted contacts on this client.
     subscribed_count + unsubscribed_count are summed across the client's lists
     (a contact can be on multiple lists with different statuses; we count
     ListContact rows for honest "list-level subscription" health).
     suppressed_count is per-agency (suppression is agency-wide). */
  const [totalContacts, subscribed, unsubscribed, suppressed] = await Promise.all([
    prisma.contact.count({
      where: { clientId, agencyId, deletedAt: null },
    }),
    prisma.listContact.count({
      where: {
        status: 'subscribed',
        contact: { clientId, agencyId, deletedAt: null },
      },
    }),
    prisma.listContact.count({
      where: {
        status: 'unsubscribed',
        contact: { clientId, agencyId, deletedAt: null },
      },
    }),
    prisma.suppression.count({
      where: { agencyId },
    }),
  ]);
  return {
    total_contacts:     totalContacts,
    subscribed_count:   subscribed,
    unsubscribed_count: unsubscribed,
    suppressed_count:   suppressed,
  };
}

export function invalidateClientReport(clientId: string): void {
  for (const key of reportCache.keys()) {
    if (key.startsWith(`${clientId}:`)) reportCache.delete(key);
  }
}
