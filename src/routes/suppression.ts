import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { requireAuth, requireRole, requireClientScope } from '../middleware/auth';
import { prisma } from '../lib/prisma';
import { notFound, badRequest, conflict } from '../lib/errors';
import { writeAudit } from '../lib/audit';

/* /v1/clients/:clientId/suppressions — feature-send-hardening V1.
   ──────────────────────────────────────────────────────────────────
   Suppression is per-AGENCY in storage (if you unsubscribe from any
   list under agency X, agency X never mails you again across all
   their clients). We mount under :clientId for two UX reasons:
     - admins manage suppressions from the contacts area for "their"
       client; the URL matches the mental model
     - audit logs naturally include clientId context via the parent
       client scope

   Per-list fine-grained subscription tracking lives in
   ListContact.status (separate, unchanged from feature-contacts-lists).

   Endpoints:
     GET    /          list (paginated by createdAt DESC)
     POST   /  admin   manually add (use case: known spammer reported)
     DELETE /:id admin remove (re-allow mailing) */

export const suppressionRouter = Router({ mergeParams: true });

/* ─── Helpers ────────────────────────────────────────────────────────────── */

const SUPPRESSION_SELECT = {
  id:        true,
  agencyId:  true,
  email:     true,
  reason:    true,
  note:      true,
  createdAt: true,
} as const;

async function assertClientExists(req: import('express').Request): Promise<void> {
  const clientId = String(req.params.clientId ?? '');
  const exists = await prisma.client.findFirst({
    where:  { id: clientId, agencyId: req.auth!.agency_id, status: { not: 'archived' } },
    select: { id: true },
  });
  if (!exists) throw notFound();
}

/* ─── GET / — list ───────────────────────────────────────────────────────── */

const listQuery = z.object({
  cursor: z.string().optional(),
  limit:  z.coerce.number().int().min(1).max(200).optional().default(50),
  search: z.string().trim().optional(),
});

suppressionRouter.get('/', requireAuth(), requireClientScope, async (req, res, next) => {
  try {
    const { cursor, limit, search } = listQuery.parse(req.query);
    await assertClientExists(req);

    const where: Prisma.SuppressionWhereInput = { agencyId: req.auth!.agency_id };
    if (search) where.email = { contains: search.toLowerCase(), mode: 'insensitive' };

    const rows = await prisma.suppression.findMany({
      where,
      select: SUPPRESSION_SELECT,
      take:   limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { createdAt: 'desc' },
    });

    const hasMore    = rows.length > limit;
    const items      = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? items[items.length - 1].id : null;

    res.json({ data: { items, nextCursor } });
  } catch (err) {
    next(err);
  }
});

/* ─── POST / — add manually (admin) ──────────────────────────────────────── */

const createBody = z.object({
  email: z.email({ message: 'Must be a valid email' }).toLowerCase(),
  note:  z.string().trim().max(280).optional(),
});

suppressionRouter.post('/', requireAuth(), requireRole('admin'), requireClientScope, async (req, res, next) => {
  try {
    const body = createBody.parse(req.body);
    await assertClientExists(req);
    const agencyId = req.auth!.agency_id;
    const userId   = req.auth!.sub;

    const existing = await prisma.suppression.findUnique({
      where: { agencyId_email: { agencyId, email: body.email } },
      select: { id: true },
    });
    if (existing) {
      return next(conflict('already_suppressed', 'This email is already in the suppression list.'));
    }

    const row = await prisma.suppression.create({
      data: {
        agencyId,
        email:  body.email,
        reason: 'manual',
        note:   body.note ?? null,
      },
      select: SUPPRESSION_SELECT,
    });

    writeAudit({
      agencyId,
      actorUserId: userId,
      action:      'suppression.added',
      targetType:  'suppression',
      targetId:    row.id,
      metadata:    { email: body.email, reason: 'manual' },
      req,
    });

    res.status(201).json({ data: { suppression: row } });
  } catch (err) {
    next(err);
  }
});

/* ─── DELETE /:id — remove (admin) ───────────────────────────────────────── */

suppressionRouter.delete('/:id', requireAuth(), requireRole('admin'), requireClientScope, async (req, res, next) => {
  try {
    await assertClientExists(req);
    const id = String(req.params.id ?? '');
    const row = await prisma.suppression.findFirst({
      where:  { id, agencyId: req.auth!.agency_id },
      select: { id: true, email: true },
    });
    if (!row) return next(notFound());

    await prisma.suppression.delete({ where: { id: row.id } });

    writeAudit({
      agencyId:    req.auth!.agency_id,
      actorUserId: req.auth!.sub,
      action:      'suppression.removed',
      targetType:  'suppression',
      targetId:    row.id,
      metadata:    { email: row.email },
      req,
    });

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/* The `badRequest` import is unused here but kept for future use when
   we add bulk-suppression-import (V2 — CSV upload route). */
void badRequest;
