import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../middleware/auth';
import { prisma } from '../lib/prisma';
import { notFound, badRequest, conflict } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import {
  createSendingDomain,
  refreshSendingDomain,
  removeSendingDomain,
} from '../lib/sending-domain';

/* /v1/sending-domains — feature-send-hardening V1.
   ──────────────────────────────────────────────
   Agency-scoped CRUD over Resend domain verification. We don't verify
   the domain ourselves — Resend does the DNS lookups. Our role is:
     1. POST    /          create domain in Resend, persist locally
     2. GET     /          list with statuses
     3. GET     /:id       single (for re-displaying DNS records)
     4. POST    /:id/check ask Resend to re-verify; update local row
     5. DELETE  /:id       remove from Resend + delete local row

   Resend free tier allows 1 verified domain per team. Schema supports
   multi-domain; the constraint surfaces if/when the user upgrades.
   Frontend hint copy will explain this. */

export const sendingDomainsRouter = Router();

/* ─── Helpers ────────────────────────────────────────────────────────────── */

const DOMAIN_SELECT = {
  id: true,
  agencyId: true,
  name: true,
  resendId: true,
  status: true,
  records: true,
  verifiedAt: true,
  lastCheckedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

async function loadDomainOr404(req: import('express').Request, domainId: string) {
  const row = await prisma.sendingDomain.findFirst({
    where:  { id: domainId, agencyId: req.auth!.agency_id },
    select: DOMAIN_SELECT,
  });
  if (!row) throw notFound();
  return row;
}

/* ─── GET / — list ───────────────────────────────────────────────────────── */

sendingDomainsRouter.get('/', requireAuth(), async (req, res, next) => {
  try {
    const rows = await prisma.sendingDomain.findMany({
      where:   { agencyId: req.auth!.agency_id },
      select:  DOMAIN_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: { items: rows } });
  } catch (err) {
    next(err);
  }
});

/* ─── GET /:id — single ──────────────────────────────────────────────────── */

sendingDomainsRouter.get('/:id', requireAuth(), async (req, res, next) => {
  try {
    const row = await loadDomainOr404(req, String(req.params.id ?? ''));
    res.json({ data: { domain: row } });
  } catch (err) {
    next(err);
  }
});

/* ─── POST / — add new (admin) ───────────────────────────────────────────── */

/* Domain names are user-input — validate format strictly to keep
   garbage out of Resend's create call. Whitespace stripped + lowercase
   because DNS is case-insensitive. */
const createBody = z.object({
  name: z.string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(253)
    .regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9.]*[a-z0-9])?)+$/, 'Invalid domain name'),
});

sendingDomainsRouter.post('/', requireAuth(), requireRole('admin'), async (req, res, next) => {
  try {
    const body = createBody.parse(req.body);
    const agencyId = req.auth!.agency_id;
    const userId   = req.auth!.sub;

    /* Catch the duplicate case before hitting Resend so we don't waste
       an API call AND the user gets a clearer error message. */
    const existing = await prisma.sendingDomain.findFirst({
      where: { agencyId, name: body.name },
      select: { id: true },
    });
    if (existing) {
      return next(conflict('already_added', 'You already added this domain.'));
    }

    let domain;
    try {
      domain = await createSendingDomain({ agencyId, name: body.name });
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Unknown Resend error';
      return next(badRequest('resend_create_failed', reason));
    }

    writeAudit({
      agencyId,
      actorUserId: userId,
      action:      'sending_domain.added',
      targetType:  'sending_domain',
      targetId:    domain.id,
      metadata:    { name: body.name },
      req,
    });

    res.status(201).json({ data: { domain } });
  } catch (err) {
    next(err);
  }
});

/* ─── POST /:id/check — re-verify (admin) ────────────────────────────────── */

sendingDomainsRouter.post('/:id/check', requireAuth(), requireRole('admin'), async (req, res, next) => {
  try {
    const row = await loadDomainOr404(req, String(req.params.id ?? ''));

    let updated;
    try {
      updated = await refreshSendingDomain(row);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Unknown Resend error';
      return next(badRequest('resend_verify_failed', reason));
    }

    /* Only audit when status TRANSITIONS — frontend will poll this
       endpoint every 30s while pending; we don't want a row per poll. */
    if (updated.status !== row.status) {
      writeAudit({
        agencyId:    row.agencyId,
        actorUserId: req.auth!.sub,
        action:      `sending_domain.${updated.status}`,    // .verified or .failed
        targetType:  'sending_domain',
        targetId:    row.id,
        metadata:    { name: row.name, from: row.status, to: updated.status },
        req,
      });
    }

    res.json({ data: { domain: updated } });
  } catch (err) {
    next(err);
  }
});

/* ─── DELETE /:id — remove (admin) ───────────────────────────────────────── */

sendingDomainsRouter.delete('/:id', requireAuth(), requireRole('admin'), async (req, res, next) => {
  try {
    const row = await loadDomainOr404(req, String(req.params.id ?? ''));
    await removeSendingDomain(row);

    writeAudit({
      agencyId:    row.agencyId,
      actorUserId: req.auth!.sub,
      action:      'sending_domain.removed',
      targetType:  'sending_domain',
      targetId:    row.id,
      metadata:    { name: row.name },
      req,
    });

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
