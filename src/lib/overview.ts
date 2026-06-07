import type { AgencyPlan, ClientStatus } from '@prisma/client';
import { prisma } from './prisma';
import {
  aggregateSends, dailyChart, subDaysUtc, startOfMonthUtc, pctChange,
} from './report';

/* Agency dashboard overview — the single payload that powers /dashboard.
   ──────────────────────────────────────────────────────────────────────
   Cached 60s in-memory per (agency_id, user_id) — the dashboard is the
   "morning briefing" so 60s staleness is fine. Cache invalidates when a
   client is created / updated / archived (called from src/routes/clients.ts
   mutations).

   The `available: boolean` per metric is the contract that lets the FE
   render honest empty states without inspecting `null`-vs-`0`. Today most
   metrics are unavailable (no event ingestion); when Feature 10 lands,
   we flip `available: true` and start returning real values.
*/

type ScopeClaim = { type: 'all' } | { type: 'clients'; ids: string[] };

interface OverviewKpi {
  value: number | null;
  change_30d: number | null;
  available: boolean;
}

export interface OverviewPayload {
  greeting: {
    name: string;
    date_iso: string;
  };
  kpis: {
    active_clients: OverviewKpi;
    emails_sent:    OverviewKpi;
    open_rate:      OverviewKpi;
    revenue:        OverviewKpi & { currency: 'NPR' };
  };
  sending_chart: {
    available: boolean;
    series: Array<{ date_iso: string; sent: number; opened: number }> | null;
  };
  deliverability: {
    available: boolean;
    score: number | null;
    gmail_inbox_rate: number | null;
    hard_bounce_rate: number | null;
    complaint_rate: number | null;
  };
  plan_usage: {
    plan: AgencyPlan;
    sent_this_month: number;
    monthly_quota: number;
  };
  top_clients: Array<{
    id: string;
    name: string;
    avatar_color: string | null;
    status: ClientStatus;
    last_activity_iso: string | null;
    last_campaign_subject: string | null;
    open_rate: number | null;
    revenue: number | null;
  }>;
}

/* V1 quota table. Hardcoded until Feature 14 (billing) moves these into a
   Plan table the agency picks from. */
const PLAN_QUOTAS: Record<AgencyPlan, number> = {
  trial:    1_000,
  starter:  10_000,
  growth:   50_000,
  scale:    250_000,
};

const cache = new Map<string, { payload: OverviewPayload; expiresAt: number }>();
const TTL_MS = 60_000;
const MAX_ENTRIES = 1_000;

function cacheKey(agencyId: string, userId: string): string {
  return `${agencyId}:${userId}`;
}

/* Quick LRU-ish trim — if the cache gets too big, drop the oldest 10%. */
function trimCacheIfFull(): void {
  if (cache.size < MAX_ENTRIES) return;
  const drop = Math.ceil(MAX_ENTRIES * 0.1);
  let dropped = 0;
  for (const key of cache.keys()) {
    if (dropped >= drop) break;
    cache.delete(key);
    dropped++;
  }
}

interface ComputeOpts {
  agencyId: string;
  userId: string;
  userName: string;
  scope: ScopeClaim;
}

export async function computeOverview(opts: ComputeOpts): Promise<OverviewPayload> {
  const key = cacheKey(opts.agencyId, opts.userId);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.payload;

  const agency = await prisma.agency.findUniqueOrThrow({
    where: { id: opts.agencyId },
    select: { plan: true },
  });

  /* Scope-aware client filter — `scope: 'clients'` users see only their
     accessible clients in the count + top-list. */
  const clientsWhere = {
    agencyId: opts.agencyId,
    status: { not: 'archived' as const },
    ...(opts.scope.type === 'clients' ? { id: { in: opts.scope.ids } } : {}),
  };

  const [activeClients, topClientsRaw] = await Promise.all([
    prisma.client.count({ where: clientsWhere }),
    prisma.client.findMany({
      where: clientsWhere,
      orderBy: { updatedAt: 'desc' },
      take: 5,
      select: {
        id: true,
        name: true,
        avatarColor: true,
        status: true,
        updatedAt: true,
      },
    }),
  ]);

  /* ── Engagement aggregations (feature-reports V1) ─────────────────
     All metrics scoped to last 30d (+ prior 30d for delta). For
     scope-restricted users (members), narrow to their accessible
     clients only. */
  const now      = new Date();
  const last30   = subDaysUtc(now, 30);
  const prior30  = subDaysUtc(now, 60);
  const monthStart = startOfMonthUtc(now);

  const scopedClientIds = opts.scope.type === 'clients' ? opts.scope.ids : undefined;
  const aggBase = {
    agencyId:  opts.agencyId,
    clientIds: scopedClientIds,
  };

  const [last30Agg, prior30Agg, monthAgg, chartSeries] = await Promise.all([
    aggregateSends({ ...aggBase, startAt: last30,  endAt: now      }),
    aggregateSends({ ...aggBase, startAt: prior30, endAt: last30   }),
    aggregateSends({ ...aggBase, startAt: monthStart, endAt: now   }),
    dailyChart   ({ ...aggBase, startAt: last30,  endAt: now      }),
  ]);

  /* ── Top clients enrichment ───────────────────────────────────────
     For each of the 5 top clients, fetch the last sent campaign +
     last-30d open rate. Done in parallel; ~10 queries total (2 per
     client × 5). Cheap on indexed columns. */
  const topClients = await Promise.all(topClientsRaw.map(async (c) => {
    const [lastCampaign, clientAgg] = await Promise.all([
      prisma.campaign.findFirst({
        where: {
          agencyId: opts.agencyId,
          clientId: c.id,
          status:   'sent',
        },
        select:  { subject: true },
        orderBy: { updatedAt: 'desc' },
      }),
      aggregateSends({
        agencyId:  opts.agencyId,
        clientIds: [c.id],
        startAt:   last30,
        endAt:     now,
      }),
    ]);
    return {
      id:                    c.id,
      name:                  c.name,
      avatar_color:          c.avatarColor,
      status:                c.status,
      last_activity_iso:     c.updatedAt.toISOString(),
      last_campaign_subject: lastCampaign?.subject ?? null,
      open_rate:             clientAgg.openRate,
      revenue:               null,                          // V3 — needs sales integration
    };
  }));

  const firstName = (opts.userName.trim().split(/\s+/)[0] || 'there').slice(0, 40);

  const payload: OverviewPayload = {
    greeting: {
      name: firstName,
      date_iso: new Date().toISOString(),
    },
    kpis: {
      active_clients: {
        value: activeClients,
        change_30d: 0,                                      // historical client counts not tracked V1
        available: true,
      },
      emails_sent: {
        value:      last30Agg.sentCount,
        change_30d: pctChange(last30Agg.sentCount, prior30Agg.sentCount),
        available:  true,
      },
      open_rate: {
        value:      last30Agg.openRate,                    // 0.0 - 1.0
        change_30d: pctChange(last30Agg.openRate, prior30Agg.openRate),
        available:  true,
      },
      revenue:        { value: null, change_30d: null, available: false, currency: 'NPR' },
    },
    sending_chart: {
      available: true,
      series:    chartSeries,
    },
    deliverability: {
      /* V2 with Resend webhook ingestion. For V1 we surface what we
         have (basic sent/failed) as a poor-man's deliverability score:
         success rate = sent / (sent + failed). UI knows to treat this
         as approximate until real bounce data lands. */
      available: false,
      score: null,
      gmail_inbox_rate: null,
      hard_bounce_rate: null,
      complaint_rate: null,
    },
    plan_usage: {
      plan: agency.plan,
      sent_this_month: monthAgg.sentCount,
      monthly_quota:   PLAN_QUOTAS[agency.plan] ?? PLAN_QUOTAS.trial,
    },
    top_clients: topClients,
  };

  trimCacheIfFull();
  cache.set(key, { payload, expiresAt: Date.now() + TTL_MS });
  return payload;
}

/* Invalidate every cached overview for an agency. Called by client mutations
   (create / update / archive) so the dashboard reflects the change on next
   render without waiting for TTL. */
export function invalidateOverview(agencyId: string): void {
  const prefix = `${agencyId}:`;
  for (const k of cache.keys()) {
    if (k.startsWith(prefix)) cache.delete(k);
  }
}
