import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { requireAuth, requireRole } from '../middleware/auth';
import { notFound, conflict } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { slugFromName } from '../lib/slug';
import { invalidateOverview } from '../lib/overview';

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

    const where = {
      agencyId,
      status: { not: 'archived' as const },
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

    const row = await prisma.client.update({
      where: { id },
      data,
      select: CLIENT_SELECT,
    });

    const changes: Prisma.InputJsonValue = {};
    for (const key of ['name', 'domain', 'avatarColor'] as const) {
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
