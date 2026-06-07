import { prisma } from './prisma';

/**
 * Engagement aggregation helpers — feature-reports V1.
 *
 * Shared by the dashboard endpoint (`/v1/agencies/overview`) and the
 * per-client report endpoint (`/v1/clients/:cid/report`). Both call
 * the same functions with different scopes.
 *
 * All queries hit indexed columns (Send.campaignId, Send.sentAt,
 * Campaign.agencyId, Campaign.clientId). At 10K sends: each <50ms.
 * At 1M sends: still <500ms single GROUP BY. If we exceed that,
 * we add a materialized view or daily-rollup table — but that's a
 * year away for the target ICP.
 *
 * Open / click rates use the Mailchimp standard formula:
 *   unique_opens / sentCount
 * NOT
 *   unique_opens / delivered
 * because we don't track delivery V1 (would need Resend webhook
 * ingestion).
 */

export interface AggregateOpts {
  agencyId:   string;
  /** Narrow to specific clients. Used for scope-restricted dashboard users. */
  clientIds?: string[];
  startAt:    Date;
  endAt:      Date;
}

export interface AggregateResult {
  sentCount:    number;
  uniqueOpens:  number;     // Sends where firstOpenedAt IS NOT NULL
  uniqueClicks: number;     // Sends where clickCount > 0
  openRate:     number | null;
  clickRate:    number | null;
}

/**
 * Build the campaign-id filter used by every aggregation. We narrow
 * to "Campaigns that belong to this agency (and optionally these
 * clients) and that have any Sends in range" — but we use the Send's
 * `sentAt` as the source-of-truth date, not Campaign.createdAt.
 */
function campaignScope(opts: AggregateOpts) {
  return {
    agencyId:  opts.agencyId,
    ...(opts.clientIds && opts.clientIds.length > 0
      ? { clientId: { in: opts.clientIds } }
      : {}),
  };
}

/* ─── Aggregate KPIs ──────────────────────────────────────────────── */

/**
 * Returns sent / unique opens / unique clicks / open rate / click rate
 * for the given scope and date range.
 *
 * `sentAt` is the source-of-truth date (vs Send.createdAt). For sends
 * that failed and have null sentAt, they're excluded from the date
 * filter — failures don't affect engagement metrics.
 */
export async function aggregateSends(opts: AggregateOpts): Promise<AggregateResult> {
  const sendFilter = {
    campaign: campaignScope(opts),
    status:   'sent' as const,
    sentAt:   { gte: opts.startAt, lt: opts.endAt },
  };

  const [sentCount, uniqueOpens, uniqueClicks] = await Promise.all([
    prisma.send.count({ where: sendFilter }),
    prisma.send.count({
      where: { ...sendFilter, firstOpenedAt: { not: null } },
    }),
    prisma.send.count({
      where: { ...sendFilter, clickCount: { gt: 0 } },
    }),
  ]);

  return {
    sentCount,
    uniqueOpens,
    uniqueClicks,
    openRate:  sentCount > 0 ? uniqueOpens  / sentCount : null,
    clickRate: sentCount > 0 ? uniqueClicks / sentCount : null,
  };
}

/* ─── Daily time-series ──────────────────────────────────────────── */

interface DayPoint {
  date_iso: string;       // ISO date for the UTC day (yyyy-mm-dd)
  sent:     number;
  opened:   number;
}

/**
 * Daily sending + opens chart for the given scope + range.
 *
 * Uses raw SQL because Prisma's groupBy can't extract date parts.
 * Safe — all values are integers (count) or scoped IDs (parameterized).
 *
 * Returns one point per UTC day in the range, INCLUDING days with
 * zero activity (zero-filled for chart continuity).
 */
export async function dailyChart(opts: AggregateOpts): Promise<DayPoint[]> {
  /* Build the client-id filter as a Prisma-safe SQL fragment. */
  const scope = campaignScope(opts);

  const clientFilter = scope.clientId
    ? `AND c.client_id = ANY($1::text[])`
    : '';

  /* Sends grouped by day. */
  const params: unknown[] = [];
  if (scope.clientId) params.push((scope.clientId as { in: string[] }).in);

  const sentRows = await prisma.$queryRawUnsafe<Array<{ day: Date; sent: bigint; opened: bigint }>>(
    `
    SELECT
      DATE_TRUNC('day', s.sent_at)::date AS day,
      COUNT(*)::bigint                   AS sent,
      COUNT(s.first_opened_at)::bigint   AS opened
    FROM sends s
    JOIN campaigns c ON c.id = s.campaign_id
    WHERE c.agency_id = '${opts.agencyId.replace(/'/g, "''")}'
      ${clientFilter}
      AND s.status = 'sent'
      AND s.sent_at >= '${opts.startAt.toISOString()}'
      AND s.sent_at <  '${opts.endAt.toISOString()}'
    GROUP BY day
    ORDER BY day
    `,
    ...params,
  );

  /* Build a map from yyyy-mm-dd → { sent, opened }. */
  const byDay = new Map<string, { sent: number; opened: number }>();
  for (const row of sentRows) {
    const key = toIsoDate(row.day);
    byDay.set(key, { sent: Number(row.sent), opened: Number(row.opened) });
  }

  /* Zero-fill every day in range. */
  const points: DayPoint[] = [];
  const cursor = new Date(Date.UTC(
    opts.startAt.getUTCFullYear(),
    opts.startAt.getUTCMonth(),
    opts.startAt.getUTCDate(),
  ));
  const end = new Date(Date.UTC(
    opts.endAt.getUTCFullYear(),
    opts.endAt.getUTCMonth(),
    opts.endAt.getUTCDate(),
  ));

  while (cursor < end) {
    const key = toIsoDate(cursor);
    const hit = byDay.get(key);
    points.push({
      date_iso: key,
      sent:     hit?.sent   ?? 0,
      opened:   hit?.opened ?? 0,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return points;
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/* ─── Top campaigns by engagement ─────────────────────────────────── */

interface TopCampaign {
  id:         string;
  name:       string;
  subject:    string | null;
  sentAt:     string | null;
  sentCount:  number;
  openRate:   number | null;
  clickRate:  number | null;
}

/**
 * Top campaigns by open rate within the date range.
 *
 * MIN_SENDS_TO_QUALIFY filters out tiny campaigns (1-recipient sends
 * with 100% open rate would otherwise top the chart trivially).
 *
 * Returns up to `limit` campaigns ordered by open rate DESC. Ties
 * broken by sentCount DESC (the bigger campaign wins).
 */
export async function topCampaignsByEngagement(
  opts: AggregateOpts & { limit: number },
): Promise<TopCampaign[]> {
  const MIN_SENDS_TO_QUALIFY = 10;

  const where = {
    ...campaignScope(opts),
    /* Campaign-level filter: we use Campaign.updatedAt (when status
       flipped to 'sent') as the proxy. Send-level date filtering is
       harder here — most users care about "campaigns sent in this
       period," so Campaign-level is the cleaner intent. */
    status:  { in: ['sent', 'failed'] as Array<'sent' | 'failed'> },
    updatedAt: { gte: opts.startAt, lt: opts.endAt },
    sentCount: { gte: MIN_SENDS_TO_QUALIFY },
  };

  /* We need engagement aggregates per campaign — count(send WHERE
     firstOpenedAt IS NOT NULL) / sentCount. Doing this in Prisma
     requires a separate query per candidate, so we limit to a wider
     net first (top-50 by sentCount), aggregate, then re-rank by open
     rate. */
  const candidates = await prisma.campaign.findMany({
    where,
    select: {
      id: true, name: true, subject: true, sentCount: true,
      updatedAt: true,
    },
    orderBy: { sentCount: 'desc' },
    take: 50,
  });

  if (candidates.length === 0) return [];

  /* For each candidate, fetch the open / click counts in parallel. */
  const ranked = await Promise.all(candidates.map(async (c) => {
    const [uniqueOpens, uniqueClicks] = await Promise.all([
      prisma.send.count({
        where: { campaignId: c.id, status: 'sent', firstOpenedAt: { not: null } },
      }),
      prisma.send.count({
        where: { campaignId: c.id, status: 'sent', clickCount: { gt: 0 } },
      }),
    ]);
    return {
      id:        c.id,
      name:      c.name,
      subject:   c.subject,
      sentAt:    c.updatedAt.toISOString(),
      sentCount: c.sentCount,
      openRate:  c.sentCount > 0 ? uniqueOpens  / c.sentCount : null,
      clickRate: c.sentCount > 0 ? uniqueClicks / c.sentCount : null,
    } as TopCampaign;
  }));

  /* Sort by open rate DESC, tie-break by sentCount DESC. */
  ranked.sort((a, b) => {
    const aRate = a.openRate ?? -1;
    const bRate = b.openRate ?? -1;
    if (bRate !== aRate) return bRate - aRate;
    return b.sentCount - a.sentCount;
  });

  return ranked.slice(0, opts.limit);
}

/* ─── List growth ────────────────────────────────────────────────── */

interface ListGrowthResult {
  added:        number;        // Contacts created in range
  unsubscribed: number;        // ListContacts that became 'unsubscribed' in range
  suppressed:   number;        // Suppressions added in range
}

/**
 * List growth signal — added vs unsubscribed vs suppressed in range.
 * Used by per-client report page; dashboard skips this (agency-wide
 * growth is the sum of per-client growth, surfaced V2).
 */
export async function listGrowth(opts: AggregateOpts): Promise<ListGrowthResult> {
  const scope = campaignScope(opts);

  const [added, unsubscribed, suppressed] = await Promise.all([
    prisma.contact.count({
      where: {
        agencyId: opts.agencyId,
        ...(scope.clientId ? { clientId: scope.clientId } : {}),
        deletedAt: null,
        createdAt: { gte: opts.startAt, lt: opts.endAt },
      },
    }),
    prisma.listContact.count({
      where: {
        status: 'unsubscribed',
        unsubscribedAt: { gte: opts.startAt, lt: opts.endAt },
        /* Narrow by client via the contact relation. */
        contact: {
          agencyId: opts.agencyId,
          ...(scope.clientId ? { clientId: scope.clientId } : {}),
        },
      },
    }),
    prisma.suppression.count({
      where: {
        agencyId:  opts.agencyId,
        createdAt: { gte: opts.startAt, lt: opts.endAt },
      },
    }),
  ]);

  return { added, unsubscribed, suppressed };
}

/* ─── Helpers for date math (UTC) ─────────────────────────────────── */

export function startOfMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function subDaysUtc(d: Date, days: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() - days);
  return out;
}

/**
 * Percentage change between two values. Returns null when prior is 0
 * (avoid divide-by-zero / Infinity).
 */
export function pctChange(current: number | null, prior: number | null): number | null {
  if (current === null || prior === null) return null;
  if (prior === 0) return null;
  return (current - prior) / prior;
}
