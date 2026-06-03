import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { requireAuth, requireClientScope } from '../middleware/auth';
import { conflict, notFound, badRequest } from '../lib/errors';
import { writeAudit } from '../lib/audit';

/* /v1/clients/:clientId/contacts — PR 1 of feature-contacts-lists.
   ─────────────────────────────────────────────────────────────────
   CRUD only — soft-delete (hard-delete + GDPR cascade lands in PR 3).
   Tags are managed inline on create/update via a `tags: string[]` array
   (names; auto-created if missing). No separate /contacts/:id/tags
   endpoint in V1 — replace-semantics on PATCH covers all the UX.
   ───────────────────────────────────────────────────────────────── */

export const contactsRouter = Router({ mergeParams: true });

/* ─── Helpers ────────────────────────────────────────────────────────────── */

const CONTACT_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  city: true,
  birthday: true,
  custom: true,
  source: true,
  createdAt: true,
  updatedAt: true,
  contactTags: { include: { tag: true } },
  listMembers: {
    include: { list: { select: { id: true, name: true } } },
  },
} as const;

type ContactRow = Prisma.ContactGetPayload<{ select: typeof CONTACT_SELECT }>;

function serialize(c: ContactRow) {
  return {
    id: c.id,
    email: c.email,
    firstName: c.firstName,
    lastName: c.lastName,
    phone: c.phone,
    city: c.city,
    birthday: c.birthday ? c.birthday.toISOString().slice(0, 10) : null,
    custom: c.custom ?? null,
    source: c.source,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    tags: c.contactTags.map((ct) => ct.tag.name).sort(),
    lists: c.listMembers.map((lm) => ({
      listId:   lm.list.id,
      listName: lm.list.name,
      status:   lm.status,
    })),
  };
}

/* Normalize a tag input string. Returns null for empty / over-long names
   so the caller can skip them. */
function normalizeTag(raw: string): string | null {
  const t = raw.trim().toLowerCase();
  if (!t || t.length > 40) return null;
  return t;
}

/* Find-or-create Tag rows for an array of tag names. Returns the resolved
   tag ids in input order (deduped). */
async function resolveTags(
  tx: Prisma.TransactionClient,
  clientId: string,
  rawNames: string[],
): Promise<string[]> {
  const names = Array.from(new Set(rawNames.map(normalizeTag).filter((t): t is string => !!t)));
  if (names.length === 0) return [];

  // Find existing
  const existing = await tx.tag.findMany({
    where: { clientId, name: { in: names } },
    select: { id: true, name: true },
  });
  const existingByName = new Map(existing.map((t) => [t.name, t.id]));

  // Create missing
  const missing = names.filter((n) => !existingByName.has(n));
  if (missing.length > 0) {
    await tx.tag.createMany({
      data: missing.map((name) => ({ clientId, name })),
      skipDuplicates: true,
    });
    const created = await tx.tag.findMany({
      where: { clientId, name: { in: missing } },
      select: { id: true, name: true },
    });
    for (const t of created) existingByName.set(t.name, t.id);
  }

  return names.map((n) => existingByName.get(n)!);
}

async function loadContactOr404(req: import('express').Request, contactId: string): Promise<ContactRow> {
  const clientId = String(req.params.clientId ?? '');
  const agencyId = req.auth!.agency_id;
  const row = await prisma.contact.findFirst({
    where: { id: contactId, clientId, agencyId, deletedAt: null },
    select: CONTACT_SELECT,
  });
  if (!row) throw notFound();
  return row;
}

/* Verify the URL :clientId corresponds to a real, non-archived client in the
   caller's agency. `requireClientScope` only checks the JWT scope claim — for
   owners with `scope: 'all'` it lets ANY clientId through, which would FK-
   violate when we try to insert nested rows (tags / contacts) for a
   nonexistent client. Call this at the top of every mutation. */
async function assertClientExists(req: import('express').Request): Promise<string> {
  const clientId = String(req.params.clientId ?? '');
  const exists = await prisma.client.findFirst({
    where: { id: clientId, agencyId: req.auth!.agency_id, status: { not: 'archived' } },
    select: { id: true },
  });
  if (!exists) throw notFound();
  return clientId;
}

/* ─── GET /  — paginated list ────────────────────────────────────────────── */

const listQuery = z.object({
  page:     z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  search:   z.string().trim().max(100).optional(),
  listId:   z.string().optional(),
  tag:      z.string().optional(),
});

contactsRouter.get('/', requireAuth(), requireClientScope, async (req, res, next) => {
  try {
    const { page, pageSize, search, listId, tag } = listQuery.parse(req.query);
    const clientId = String(req.params.clientId ?? '');
    const agencyId = req.auth!.agency_id;

    const where: Prisma.ContactWhereInput = {
      clientId, agencyId, deletedAt: null,
    };
    if (search) {
      const q = search.toLowerCase();
      where.OR = [
        { emailLower: { contains: q } },
        { firstName:  { contains: search, mode: 'insensitive' } },
        { lastName:   { contains: search, mode: 'insensitive' } },
        { city:       { contains: search, mode: 'insensitive' } },
      ];
    }
    if (listId) {
      where.listMembers = { some: { listId, status: 'subscribed' } };
    }
    if (tag) {
      const t = normalizeTag(tag);
      if (t) where.contactTags = { some: { tag: { name: t, clientId } } };
    }

    const [items, total] = await Promise.all([
      prisma.contact.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: CONTACT_SELECT,
      }),
      prisma.contact.count({ where }),
    ]);

    res.json({
      data: {
        items: items.map(serialize),
        total,
        page,
        pageSize,
      },
    });
  } catch (err) {
    next(err);
  }
});

/* ─── GET /:id ───────────────────────────────────────────────────────────── */

contactsRouter.get('/:id', requireAuth(), requireClientScope, async (req, res, next) => {
  try {
    const row = await loadContactOr404(req, String(req.params.id ?? ''));
    res.json({ data: { contact: serialize(row) } });
  } catch (err) {
    next(err);
  }
});

/* ─── POST /  — create ───────────────────────────────────────────────────── */

const createBody = z.object({
  email:     z.string().trim().toLowerCase().email(),
  firstName: z.string().trim().min(1).max(80).nullish(),
  lastName:  z.string().trim().min(1).max(80).nullish(),
  phone:     z.string().trim().min(1).max(40).nullish(),
  city:      z.string().trim().min(1).max(80).nullish(),
  birthday:  z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  custom:    z.record(z.string(), z.any()).nullish(),
  tags:      z.array(z.string()).max(20).default([]),
  listIds:   z.array(z.string()).max(20).default([]),
}).strict();

contactsRouter.post('/', requireAuth(), requireClientScope, async (req, res, next) => {
  try {
    const body = createBody.parse(req.body);
    const clientId = await assertClientExists(req);   // catches owner+fake-id (would FK-violate downstream)
    const agencyId = req.auth!.agency_id;

    // 10-custom-fields cap (impl doc §V1 scope)
    if (body.custom && Object.keys(body.custom).length > 10) {
      throw badRequest('too_many_custom_fields', 'A contact can have at most 10 custom fields.', {
        field: 'custom',
      });
    }

    // Validate list ids belong to this client (silently drop the rest)
    let validListIds: string[] = [];
    if (body.listIds.length > 0) {
      const found = await prisma.list.findMany({
        where: { id: { in: body.listIds }, clientId, archived: false },
        select: { id: true },
      });
      validListIds = found.map((l) => l.id);
    }

    let row: ContactRow;
    try {
      row = await prisma.$transaction(async (tx) => {
        const tagIds = await resolveTags(tx, clientId, body.tags);

        const created = await tx.contact.create({
          data: {
            agencyId,
            clientId,
            email:      body.email,
            emailLower: body.email,
            firstName:  body.firstName ?? null,
            lastName:   body.lastName  ?? null,
            phone:      body.phone     ?? null,
            city:       body.city      ?? null,
            birthday:   body.birthday  ? new Date(`${body.birthday}T00:00:00Z`) : null,
            custom:     body.custom    ?? undefined,
            source:     'manual',
            contactTags:  { create: tagIds.map((tagId) => ({ tagId })) },
            listMembers:  { create: validListIds.map((listId) => ({ listId })) },
          },
          select: CONTACT_SELECT,
        });
        return created;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw conflict(
          'email_taken',
          'A contact with this email already exists for this client.',
          { field: 'email' },
        );
      }
      throw err;
    }

    writeAudit({
      agencyId,
      actorUserId: req.auth!.sub,
      action:      'contact.created',
      targetType:  'contact',
      targetId:    row.id,
      metadata:    { clientId, email: row.email },
      req,
    });

    res.status(201).json({ data: { contact: serialize(row) } });
  } catch (err) {
    next(err);
  }
});

/* ─── PATCH /:id  — update ──────────────────────────────────────────────────
   Email is immutable in V1 (changes break dedupe + send history).
   `tags` replaces the entire tag set. */

const updateBody = z.object({
  firstName: z.string().trim().min(1).max(80).nullish(),
  lastName:  z.string().trim().min(1).max(80).nullish(),
  phone:     z.string().trim().min(1).max(40).nullish(),
  city:      z.string().trim().min(1).max(80).nullish(),
  birthday:  z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  custom:    z.record(z.string(), z.any()).nullish(),
  tags:      z.array(z.string()).max(20).optional(),
}).strict();

contactsRouter.patch('/:id', requireAuth(), requireClientScope, async (req, res, next) => {
  try {
    const body = updateBody.parse(req.body);
    const before = await loadContactOr404(req, String(req.params.id ?? ''));
    const clientId = before.id ? String(req.params.clientId ?? '') : '';

    if (body.custom && Object.keys(body.custom).length > 10) {
      throw badRequest('too_many_custom_fields', 'A contact can have at most 10 custom fields.', {
        field: 'custom',
      });
    }

    const row = await prisma.$transaction(async (tx) => {
      // Update scalar fields
      const data: Prisma.ContactUpdateInput = {};
      if (body.firstName !== undefined) data.firstName = body.firstName ?? null;
      if (body.lastName  !== undefined) data.lastName  = body.lastName  ?? null;
      if (body.phone     !== undefined) data.phone     = body.phone     ?? null;
      if (body.city      !== undefined) data.city      = body.city      ?? null;
      if (body.birthday  !== undefined) data.birthday  = body.birthday ? new Date(`${body.birthday}T00:00:00Z`) : null;
      if (body.custom    !== undefined) data.custom    = body.custom    ?? undefined;

      if (Object.keys(data).length > 0) {
        await tx.contact.update({ where: { id: before.id }, data });
      }

      // Replace tag set if provided
      if (body.tags !== undefined) {
        const tagIds = await resolveTags(tx, clientId, body.tags);
        await tx.contactTag.deleteMany({ where: { contactId: before.id } });
        if (tagIds.length > 0) {
          await tx.contactTag.createMany({
            data: tagIds.map((tagId) => ({ contactId: before.id, tagId })),
          });
        }
      }

      return tx.contact.findUniqueOrThrow({
        where: { id: before.id },
        select: CONTACT_SELECT,
      });
    });

    writeAudit({
      agencyId:    req.auth!.agency_id,
      actorUserId: req.auth!.sub,
      action:      'contact.updated',
      targetType:  'contact',
      targetId:    row.id,
      metadata:    { clientId, email: row.email },
      req,
    });

    res.json({ data: { contact: serialize(row) } });
  } catch (err) {
    next(err);
  }
});

/* ─── DELETE /:id  — soft-delete ──────────────────────────────────────────── */

contactsRouter.delete('/:id', requireAuth(), requireClientScope, async (req, res, next) => {
  try {
    const row = await loadContactOr404(req, String(req.params.id ?? ''));
    await prisma.contact.update({
      where: { id: row.id },
      data:  { deletedAt: new Date() },
    });
    writeAudit({
      agencyId:    req.auth!.agency_id,
      actorUserId: req.auth!.sub,
      action:      'contact.deleted',
      targetType:  'contact',
      targetId:    row.id,
      metadata:    { clientId: String(req.params.clientId ?? ''), email: row.email, softDelete: true },
      req,
    });
    res.json({ data: { id: row.id } });
  } catch (err) {
    next(err);
  }
});
