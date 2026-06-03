import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { requireAuth, requireClientScope } from '../middleware/auth';
import { notFound, badRequest } from '../lib/errors';
import { writeAudit } from '../lib/audit';

/* /v1/clients/:clientId/lists — PR 1 of feature-contacts-lists.
   ─────────────────────────────────────────────────────────────
   V1 ships STATIC lists only. Dynamic lists (rule-based, auto-updating)
   return 501 Not Implemented until PR 3 (segments + suppression).

   Membership endpoints handle adding contacts to a list, removing them,
   and updating their per-list subscription status. Removing membership
   is a hard-delete of the list_contact join row; per-list "unsubscribe"
   is a status change, not a removal. */

export const listsRouter = Router({ mergeParams: true });

/* ─── Helpers ────────────────────────────────────────────────────────────── */

interface ListWithCount {
  id: string;
  clientId: string;
  name: string;
  description: string | null;
  type: 'static' | 'dynamic';
  archived: boolean;
  createdAt: Date;
  updatedAt: Date;
  _count?: { members: number };
}

function serialize(l: ListWithCount, memberCount: number) {
  return {
    id:          l.id,
    name:        l.name,
    description: l.description,
    type:        l.type,
    archived:    l.archived,
    memberCount,
    createdAt:   l.createdAt.toISOString(),
    updatedAt:   l.updatedAt.toISOString(),
  };
}

async function loadListOr404(req: import('express').Request, listId: string) {
  const clientId = String(req.params.clientId ?? '');
  const row = await prisma.list.findFirst({
    where: { id: listId, clientId, client: { agencyId: req.auth!.agency_id } },
  });
  if (!row) throw notFound();
  return row;
}

/* Verify the URL :clientId is a real, non-archived client in the caller's
   agency. Needed for POST /lists — `requireClientScope` only checks the JWT
   scope, so owners with `scope: 'all'` can pass any clientId through and
   we'd FK-violate when inserting. (PATCH/DELETE flows already 404 via
   loadListOr404 since their queries filter by agencyId.) */
async function assertClientExists(req: import('express').Request): Promise<string> {
  const clientId = String(req.params.clientId ?? '');
  const exists = await prisma.client.findFirst({
    where: { id: clientId, agencyId: req.auth!.agency_id, status: { not: 'archived' } },
    select: { id: true },
  });
  if (!exists) throw notFound();
  return clientId;
}

/* Count subscribed members of a list (the number we show in the UI). */
function memberCountWhere(listId: string): Prisma.ListContactWhereInput {
  return { listId, status: 'subscribed' };
}

/* ─── GET /  — list all (non-archived by default) ────────────────────────── */

const listQuery = z.object({
  includeArchived: z.coerce.boolean().default(false),
});

listsRouter.get('/', requireAuth(), requireClientScope, async (req, res, next) => {
  try {
    const { includeArchived } = listQuery.parse(req.query);
    const clientId = String(req.params.clientId ?? '');

    const rows = await prisma.list.findMany({
      where: {
        clientId,
        client: { agencyId: req.auth!.agency_id },
        ...(includeArchived ? {} : { archived: false }),
      },
      orderBy: { createdAt: 'desc' },
    });

    // Subscribed counts in one round-trip
    const counts = await prisma.listContact.groupBy({
      by: ['listId'],
      where: { listId: { in: rows.map((r) => r.id) }, status: 'subscribed' },
      _count: { _all: true },
    });
    const countByList = new Map(counts.map((c) => [c.listId, c._count._all]));

    res.json({
      data: {
        items: rows.map((l) => serialize(l, countByList.get(l.id) ?? 0)),
      },
    });
  } catch (err) {
    next(err);
  }
});

/* ─── GET /:listId ───────────────────────────────────────────────────────── */

listsRouter.get('/:listId', requireAuth(), requireClientScope, async (req, res, next) => {
  try {
    const row = await loadListOr404(req, String(req.params.listId ?? ''));
    const memberCount = await prisma.listContact.count({ where: memberCountWhere(row.id) });
    res.json({ data: { list: serialize(row, memberCount) } });
  } catch (err) {
    next(err);
  }
});

/* ─── POST /  — create ───────────────────────────────────────────────────── */

const createBody = z.object({
  name:        z.string().trim().min(1).max(80),
  description: z.string().trim().max(200).nullish(),
  type:        z.enum(['static', 'dynamic']).default('static'),
}).strict();

listsRouter.post('/', requireAuth(), requireClientScope, async (req, res, next) => {
  try {
    const body = createBody.parse(req.body);
    const clientId = await assertClientExists(req);   // catches owner+fake-id (would FK-violate downstream)

    if (body.type === 'dynamic') {
      throw badRequest(
        'not_implemented',
        'Dynamic (rule-based) lists ship in feature-contacts-lists PR 3.',
        { field: 'type' },
      );
    }

    const row = await prisma.list.create({
      data: {
        agencyId:    req.auth!.agency_id,
        clientId,
        name:        body.name,
        description: body.description ?? null,
        type:        'static',
      },
    });

    writeAudit({
      agencyId:    req.auth!.agency_id,
      actorUserId: req.auth!.sub,
      action:      'list.created',
      targetType:  'list',
      targetId:    row.id,
      metadata:    { clientId, name: row.name, type: row.type },
      req,
    });

    res.status(201).json({ data: { list: serialize(row, 0) } });
  } catch (err) {
    next(err);
  }
});

/* ─── PATCH /:listId  — update ──────────────────────────────────────────── */

const updateBody = z.object({
  name:        z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(200).nullish(),
  archived:    z.boolean().optional(),
}).strict();

listsRouter.patch('/:listId', requireAuth(), requireClientScope, async (req, res, next) => {
  try {
    const body = updateBody.parse(req.body);
    const before = await loadListOr404(req, String(req.params.listId ?? ''));

    const data: Prisma.ListUpdateInput = {};
    if (body.name        !== undefined) data.name        = body.name;
    if (body.description !== undefined) data.description = body.description ?? null;
    if (body.archived    !== undefined) data.archived    = body.archived;

    const row = await prisma.list.update({ where: { id: before.id }, data });
    const memberCount = await prisma.listContact.count({ where: memberCountWhere(row.id) });

    writeAudit({
      agencyId:    req.auth!.agency_id,
      actorUserId: req.auth!.sub,
      action:      'list.updated',
      targetType:  'list',
      targetId:    row.id,
      metadata:    { clientId: String(req.params.clientId ?? ''), changes: body },
      req,
    });

    res.json({ data: { list: serialize(row, memberCount) } });
  } catch (err) {
    next(err);
  }
});

/* ─── DELETE /:listId  — archive ─────────────────────────────────────────── */

listsRouter.delete('/:listId', requireAuth(), requireClientScope, async (req, res, next) => {
  try {
    const before = await loadListOr404(req, String(req.params.listId ?? ''));
    const row = before.archived
      ? before
      : await prisma.list.update({ where: { id: before.id }, data: { archived: true } });

    if (!before.archived) {
      writeAudit({
        agencyId:    req.auth!.agency_id,
        actorUserId: req.auth!.sub,
        action:      'list.archived',
        targetType:  'list',
        targetId:    row.id,
        metadata:    { clientId: String(req.params.clientId ?? ''), name: row.name },
        req,
      });
    }

    const memberCount = await prisma.listContact.count({ where: memberCountWhere(row.id) });
    res.json({ data: { list: serialize(row, memberCount) } });
  } catch (err) {
    next(err);
  }
});

/* ─── Membership ────────────────────────────────────────────────────────── */

const addMembersBody = z.object({
  contactIds: z.array(z.string()).min(1).max(500),
}).strict();

listsRouter.post('/:listId/contacts', requireAuth(), requireClientScope, async (req, res, next) => {
  try {
    const body = addMembersBody.parse(req.body);
    const before = await loadListOr404(req, String(req.params.listId ?? ''));
    const clientId = String(req.params.clientId ?? '');

    // Verify all contactIds belong to THIS client (silently drop the rest)
    const valid = await prisma.contact.findMany({
      where: { id: { in: body.contactIds }, clientId, deletedAt: null },
      select: { id: true },
    });
    const validIds = valid.map((c) => c.id);

    if (validIds.length === 0) {
      res.json({ data: { added: 0 } });
      return;
    }

    const result = await prisma.listContact.createMany({
      data: validIds.map((contactId) => ({ listId: before.id, contactId })),
      skipDuplicates: true,        // idempotent — re-add is a no-op
    });

    writeAudit({
      agencyId:    req.auth!.agency_id,
      actorUserId: req.auth!.sub,
      action:      'list.members_added',
      targetType:  'list',
      targetId:    before.id,
      metadata:    { clientId, added: result.count, requested: body.contactIds.length },
      req,
    });

    res.json({ data: { added: result.count } });
  } catch (err) {
    next(err);
  }
});

listsRouter.delete('/:listId/contacts/:contactId', requireAuth(), requireClientScope, async (req, res, next) => {
  try {
    const before = await loadListOr404(req, String(req.params.listId ?? ''));
    const contactId = String(req.params.contactId ?? '');

    const deleted = await prisma.listContact.deleteMany({
      where: { listId: before.id, contactId },
    });

    if (deleted.count > 0) {
      writeAudit({
        agencyId:    req.auth!.agency_id,
        actorUserId: req.auth!.sub,
        action:      'list.member_removed',
        targetType:  'list',
        targetId:    before.id,
        metadata:    { clientId: String(req.params.clientId ?? ''), contactId },
        req,
      });
    }

    res.json({ data: { removed: deleted.count } });
  } catch (err) {
    next(err);
  }
});

const updateMembershipBody = z.object({
  status: z.enum(['subscribed', 'unsubscribed', 'pending']),
}).strict();

listsRouter.patch('/:listId/contacts/:contactId', requireAuth(), requireClientScope, async (req, res, next) => {
  try {
    const body = updateMembershipBody.parse(req.body);
    const before = await loadListOr404(req, String(req.params.listId ?? ''));
    const contactId = String(req.params.contactId ?? '');

    const row = await prisma.listContact.update({
      where: { listId_contactId: { listId: before.id, contactId } },
      data:  {
        status: body.status,
        ...(body.status === 'unsubscribed' ? { unsubscribedAt: new Date() } : { unsubscribedAt: null }),
      },
    });

    writeAudit({
      agencyId:    req.auth!.agency_id,
      actorUserId: req.auth!.sub,
      action:      'list.member_status_changed',
      targetType:  'list',
      targetId:    before.id,
      metadata:    { clientId: String(req.params.clientId ?? ''), contactId, status: body.status },
      req,
    });

    res.json({ data: { membership: { listId: row.listId, contactId: row.contactId, status: row.status } } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      return next(notFound());
    }
    next(err);
  }
});
