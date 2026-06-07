import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { requireAuth, requireRole, requireClientScope } from '../middleware/auth';
import { prisma } from '../lib/prisma';
import { notFound, badRequest, conflict } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { validateSlug, generateUniqueSlug, suggestSlug } from '../lib/form-slug';

/* /v1/clients/:clientId/forms — admin CRUD for signup forms.
   ──────────────────────────────────────────────────────────
   Forms are scoped under a client URL for UX consistency (forms live
   inside the contacts area), but slugs are GLOBALLY unique because
   the public URL is /f/{slug} without client disambiguation.

   Endpoints:
     GET    /          list (cursor-paginated)
     GET    /:id       single form + recent submissions
     POST   /  admin   create
     PATCH  /:id admin update
     DELETE /:id admin archive (soft) */

export const formsRouter = Router({ mergeParams: true });

/* ─── Select shapes ─────────────────────────────────────────────────────── */

const FORM_SUMMARY_SELECT = {
  id:               true,
  agencyId:         true,
  clientId:         true,
  listId:           true,
  slug:             true,
  name:             true,
  status:           true,
  submissionCount:  true,
  archived:         true,
  createdAt:        true,
  updatedAt:        true,
} as const;

const FORM_FULL_SELECT = {
  ...FORM_SUMMARY_SELECT,
  headline:         true,
  subheadline:      true,
  buttonText:       true,
  thankYouMessage:  true,
  collectFirstName: true,
  collectLastName:  true,
  brandColor:       true,
  requireConsent:   true,
  consentText:      true,
} as const;

const SUBMISSION_SELECT = {
  id:           true,
  formId:       true,
  contactId:    true,
  email:        true,
  firstName:    true,
  lastName:     true,
  consentGiven: true,
  isNewContact: true,
  createdAt:    true,
} as const;

/* ─── Helpers ────────────────────────────────────────────────────────────── */

async function assertClientExists(req: import('express').Request): Promise<void> {
  const clientId = String(req.params.clientId ?? '');
  const exists = await prisma.client.findFirst({
    where:  { id: clientId, agencyId: req.auth!.agency_id, status: { not: 'archived' } },
    select: { id: true },
  });
  if (!exists) throw notFound();
}

async function loadFormOr404(req: import('express').Request, formId: string) {
  const clientId = String(req.params.clientId ?? '');
  const row = await prisma.form.findFirst({
    where: { id: formId, clientId, agencyId: req.auth!.agency_id },
    select: FORM_FULL_SELECT,
  });
  if (!row) throw notFound();
  return row;
}

/* ─── GET / — list ───────────────────────────────────────────────────────── */

const listQuery = z.object({
  cursor:          z.string().optional(),
  limit:           z.coerce.number().int().min(1).max(100).optional().default(50),
  includeArchived: z.coerce.boolean().optional().default(false),
});

formsRouter.get('/', requireAuth(), requireClientScope, async (req, res, next) => {
  try {
    const { cursor, limit, includeArchived } = listQuery.parse(req.query);
    await assertClientExists(req);
    const clientId = String(req.params.clientId ?? '');

    const where: Prisma.FormWhereInput = {
      clientId,
      agencyId: req.auth!.agency_id,
      ...(includeArchived ? {} : { archived: false }),
    };

    const rows = await prisma.form.findMany({
      where,
      select: {
        ...FORM_SUMMARY_SELECT,
        list: { select: { id: true, name: true } },
      },
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

/* ─── GET /:id — single + recent submissions ─────────────────────────────── */

formsRouter.get('/:id', requireAuth(), requireClientScope, async (req, res, next) => {
  try {
    await assertClientExists(req);
    const form = await loadFormOr404(req, String(req.params.id ?? ''));

    /* Recent submissions for the detail page (last 50). Full pagination
       is V1.5 polish — for now show latest 50 with isNewContact + email. */
    const recentSubmissions = await prisma.formSubmission.findMany({
      where:   { formId: form.id },
      select:  SUBMISSION_SELECT,
      orderBy: { createdAt: 'desc' },
      take:    50,
    });

    /* New-contact count (distinct from total submissions). */
    const newContactCount = await prisma.formSubmission.count({
      where: { formId: form.id, isNewContact: true },
    });

    const list = await prisma.list.findUnique({
      where:  { id: form.listId },
      select: { id: true, name: true },
    });

    res.json({
      data: {
        form,
        list,
        newContactCount,
        recentSubmissions,
      },
    });
  } catch (err) {
    next(err);
  }
});

/* ─── POST / — create (admin) ────────────────────────────────────────────── */

const createBody = z.object({
  name:             z.string().trim().min(1, 'Form name is required').max(200),
  listId:           z.string().min(1, 'List is required'),
  slug:             z.string().trim().toLowerCase().optional(),
  headline:         z.string().trim().max(200).optional(),
  subheadline:      z.string().trim().max(400).optional(),
  buttonText:       z.string().trim().min(1).max(60).optional(),
  thankYouMessage:  z.string().trim().min(1).max(400).optional(),
  collectFirstName: z.boolean().optional(),
  collectLastName:  z.boolean().optional(),
  brandColor:       z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a hex color (#RRGGBB)').nullable().optional(),
  requireConsent:   z.boolean().optional(),
  consentText:      z.string().trim().max(400).nullable().optional(),
}).strict();

formsRouter.post('/', requireAuth(), requireRole('admin'), requireClientScope, async (req, res, next) => {
  try {
    const body = createBody.parse(req.body);
    await assertClientExists(req);
    const agencyId = req.auth!.agency_id;
    const userId   = req.auth!.sub;
    const clientId = String(req.params.clientId ?? '');

    /* Verify list belongs to this client. */
    const list = await prisma.list.findFirst({
      where:  { id: body.listId, clientId },
      select: { id: true, archived: true },
    });
    if (!list) {
      return next(badRequest('invalid_list', 'That list does not exist on this client.'));
    }
    if (list.archived) {
      return next(badRequest('archived_list', 'Cannot create a form against an archived list.'));
    }

    /* Resolve slug:
        - If user provided one, validate format + check uniqueness
        - Otherwise auto-generate from agency name + form name */
    let slug: string;
    if (body.slug) {
      const validation = validateSlug(body.slug);
      if (!validation.ok) {
        return next(badRequest('invalid_slug', validation.error));
      }
      const collision = await prisma.form.findUnique({ where: { slug: body.slug }, select: { id: true } });
      if (collision) {
        return next(conflict('slug_taken', 'That URL is taken. Please choose a different one.'));
      }
      slug = body.slug;
    } else {
      const agency = await prisma.agency.findUnique({ where: { id: agencyId }, select: { name: true } });
      const base   = suggestSlug(agency?.name ?? 'form', body.name);
      slug = await generateUniqueSlug(base);
    }

    const created = await prisma.form.create({
      data: {
        agencyId,
        clientId,
        listId:           body.listId,
        slug,
        name:             body.name,
        headline:         body.headline ?? null,
        subheadline:      body.subheadline ?? null,
        buttonText:       body.buttonText ?? 'Subscribe',
        thankYouMessage:  body.thankYouMessage ?? "Thanks! We'll be in touch.",
        collectFirstName: body.collectFirstName ?? false,
        collectLastName:  body.collectLastName ?? false,
        brandColor:       body.brandColor ?? null,
        requireConsent:   body.requireConsent ?? false,
        consentText:      body.consentText ?? null,
      },
      select: FORM_FULL_SELECT,
    });

    writeAudit({
      agencyId,
      actorUserId: userId,
      action:      'form.created',
      targetType:  'form',
      targetId:    created.id,
      metadata:    { name: created.name, slug: created.slug, listId: body.listId },
      req,
    });

    res.status(201).json({ data: { form: created } });
  } catch (err) {
    next(err);
  }
});

/* ─── PATCH /:id — update (admin) ────────────────────────────────────────── */

const updateBody = z.object({
  name:             z.string().trim().min(1).max(200).optional(),
  listId:           z.string().min(1).optional(),
  slug:             z.string().trim().toLowerCase().optional(),
  headline:         z.string().trim().max(200).nullable().optional(),
  subheadline:      z.string().trim().max(400).nullable().optional(),
  buttonText:       z.string().trim().min(1).max(60).optional(),
  thankYouMessage:  z.string().trim().min(1).max(400).optional(),
  collectFirstName: z.boolean().optional(),
  collectLastName:  z.boolean().optional(),
  brandColor:       z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  requireConsent:   z.boolean().optional(),
  consentText:      z.string().trim().max(400).nullable().optional(),
  status:           z.enum(['active', 'paused']).optional(),
  archived:         z.boolean().optional(),
}).strict();

formsRouter.patch('/:id', requireAuth(), requireRole('admin'), requireClientScope, async (req, res, next) => {
  try {
    const body = updateBody.parse(req.body);
    await assertClientExists(req);
    const existing = await loadFormOr404(req, String(req.params.id ?? ''));

    /* If slug changed, validate + check uniqueness. */
    if (body.slug && body.slug !== existing.slug) {
      const validation = validateSlug(body.slug);
      if (!validation.ok) {
        return next(badRequest('invalid_slug', validation.error));
      }
      const collision = await prisma.form.findUnique({
        where:  { slug: body.slug },
        select: { id: true },
      });
      if (collision) {
        return next(conflict('slug_taken', 'That URL is taken. Please choose a different one.'));
      }
    }

    /* If list changed, verify it belongs to this client + isn't archived. */
    if (body.listId && body.listId !== existing.listId) {
      const list = await prisma.list.findFirst({
        where:  { id: body.listId, clientId: existing.clientId },
        select: { archived: true },
      });
      if (!list) {
        return next(badRequest('invalid_list', 'That list does not exist on this client.'));
      }
      if (list.archived) {
        return next(badRequest('archived_list', 'Cannot point a form at an archived list.'));
      }
    }

    const updated = await prisma.form.update({
      where: { id: existing.id },
      data:  body,
      select: FORM_FULL_SELECT,
    });

    writeAudit({
      agencyId:    existing.agencyId,
      actorUserId: req.auth!.sub,
      action:      'form.updated',
      targetType:  'form',
      targetId:    existing.id,
      metadata:    Object.keys(body),
      req,
    });

    res.json({ data: { form: updated } });
  } catch (err) {
    next(err);
  }
});

/* ─── DELETE /:id — archive (admin) ──────────────────────────────────────── */

formsRouter.delete('/:id', requireAuth(), requireRole('admin'), requireClientScope, async (req, res, next) => {
  try {
    await assertClientExists(req);
    const existing = await loadFormOr404(req, String(req.params.id ?? ''));

    /* Soft archive — preserves submission history for audit purposes. */
    await prisma.form.update({
      where: { id: existing.id },
      data:  { archived: true, status: 'paused' },
    });

    writeAudit({
      agencyId:    existing.agencyId,
      actorUserId: req.auth!.sub,
      action:      'form.archived',
      targetType:  'form',
      targetId:    existing.id,
      metadata:    { name: existing.name, slug: existing.slug },
      req,
    });

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
