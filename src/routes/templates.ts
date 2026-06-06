import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { requireAuth, requireClientScope, requireRole } from '../middleware/auth';
import { notFound, badRequest } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { sendRawHtml } from '../lib/email';
import { mjml2htmlProcessed } from '../mjml/mjmlWrapper';

/* /v1/clients/:clientId/templates — PR 2 of feature-templates.
   ──────────────────────────────────────────────────────────────
   CRUD for reusable email designs. The MJML tree is persisted as JSON in
   `mjml_source`. No subject / preheader / from columns: those are envelope
   metadata owned by Campaign (Feature 06).

   Endpoints:
     GET    /                — list (TemplateSummary[], no mjmlSource for payload weight)
     GET    /:id             — single template (full, includes mjmlSource)
     POST   /                — create (admin)
     PATCH  /:id             — update (admin) — strips editor-only fields + mj-preview nodes
     DELETE /:id             — soft-archive (admin)
     POST   /:id/duplicate   — deep clone (admin) — appends " (copy)" to name
     POST   /:id/test-send   — compile + send the saved tree to one address (any member)
   ────────────────────────────────────────────────────────────── */

export const templatesRouter = Router({ mergeParams: true });

/* ─── Helpers ────────────────────────────────────────────────────────────── */

/* Columns returned on the FULL view (single get, create, update, duplicate). */
const TEMPLATE_FULL_SELECT = {
  id: true,
  agencyId: true,
  clientId: true,
  name: true,
  mjmlSource: true,
  thumbnailUrl: true,
  category: true,
  isStarter: true,
  archived: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
} as const;

/* Columns returned on the LIST view — omits `mjmlSource` (a single template
   tree is 20-100 KB JSON; a 30-template list would be 600 KB-3 MB if we
   returned full trees). The grid only needs name + meta. */
const TEMPLATE_SUMMARY_SELECT = {
  id: true,
  agencyId: true,
  clientId: true,
  name: true,
  thumbnailUrl: true,
  category: true,
  isStarter: true,
  archived: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
} as const;

type TemplateFullRow    = Prisma.TemplateGetPayload<{ select: typeof TEMPLATE_FULL_SELECT    }>;
type TemplateSummaryRow = Prisma.TemplateGetPayload<{ select: typeof TEMPLATE_SUMMARY_SELECT }>;

function serializeFull(t: TemplateFullRow) {
  return {
    id:           t.id,
    agencyId:     t.agencyId,
    clientId:     t.clientId,
    name:         t.name,
    mjmlSource:   t.mjmlSource,
    thumbnailUrl: t.thumbnailUrl,
    category:     t.category,
    isStarter:    t.isStarter,
    archived:     t.archived,
    createdBy:    t.createdBy,
    createdAt:    t.createdAt.toISOString(),
    updatedAt:    t.updatedAt.toISOString(),
  };
}

function serializeSummary(t: TemplateSummaryRow) {
  return {
    id:           t.id,
    agencyId:     t.agencyId,
    clientId:     t.clientId,
    name:         t.name,
    thumbnailUrl: t.thumbnailUrl,
    category:     t.category,
    isStarter:    t.isStarter,
    archived:     t.archived,
    createdBy:    t.createdBy,
    createdAt:    t.createdAt.toISOString(),
    updatedAt:    t.updatedAt.toISOString(),
  };
}

/* Strip editor-only fields (`_id`, `_meta`) AND any `mj-preview` nodes from
   the persisted tree. Mirrors the frontend's tree/strip.ts contract — we
   accept either pre-stripped or raw trees and persist a clean version.

   Preheader (mj-preview) is campaign-level envelope metadata, not template
   design. Drop it here so a template never carries baked-in preheader text.
   When a campaign sends, it injects its own mj-preview before compile. */
function stripTreeForPersistence(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(stripTreeForPersistence);

  const obj = node as Record<string, unknown>;

  // Recursively strip children, dropping any whose tagName is 'mj-preview'.
  let children = obj.children;
  if (Array.isArray(children)) {
    children = children
      .filter((c): c is Record<string, unknown> => {
        if (!c || typeof c !== 'object') return false;
        return (c as Record<string, unknown>).tagName !== 'mj-preview';
      })
      .map(stripTreeForPersistence);
  }

  // Build the clean copy without the editor-only fields.
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === '_id' || k === '_meta') continue;       // editor-only
    if (k === 'children') continue;                    // handled above
    clean[k] = v;
  }
  if (Array.isArray(children)) clean.children = children;

  return clean;
}

/* Verify the URL :clientId belongs to the caller's agency and isn't archived.
   `requireClientScope` only checks the JWT scope claim — for `scope: 'all'`
   owners it lets ANY clientId through, which would FK-violate at insert
   time. Call this at the top of every endpoint that touches the templates
   table. */
async function assertClientExists(req: import('express').Request): Promise<string> {
  const clientId = String(req.params.clientId ?? '');
  const exists = await prisma.client.findFirst({
    where: { id: clientId, agencyId: req.auth!.agency_id, status: { not: 'archived' } },
    select: { id: true },
  });
  if (!exists) throw notFound();
  return clientId;
}

/* Load a template by id, scoped to (clientId, agencyId). Returns 404 if not
   found OR if the template belongs to another agency / client — never leak
   existence across tenancy boundaries. */
async function loadTemplateOr404(
  req: import('express').Request,
  templateId: string,
): Promise<TemplateFullRow> {
  const clientId = String(req.params.clientId ?? '');
  const agencyId = req.auth!.agency_id;
  const row = await prisma.template.findFirst({
    where: { id: templateId, clientId, agencyId },
    select: TEMPLATE_FULL_SELECT,
  });
  if (!row) throw notFound();
  return row;
}

/* ─── GET / — list ───────────────────────────────────────────────────────── */

const listQuery = z.object({
  includeArchived: z.coerce.boolean().optional().default(false),
});

templatesRouter.get('/', requireAuth(), requireClientScope, async (req, res, next) => {
  try {
    const { includeArchived } = listQuery.parse(req.query);
    const clientId = await assertClientExists(req);
    const agencyId = req.auth!.agency_id;

    const where: Prisma.TemplateWhereInput = {
      agencyId,
      clientId,
    };
    if (!includeArchived) where.archived = false;

    const items = await prisma.template.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      select: TEMPLATE_SUMMARY_SELECT,
    });

    res.json({ data: { items: items.map(serializeSummary) } });
  } catch (err) {
    next(err);
  }
});

/* ─── GET /:id — single (full, includes mjmlSource) ──────────────────────── */

templatesRouter.get('/:id', requireAuth(), requireClientScope, async (req, res, next) => {
  try {
    await assertClientExists(req);
    const row = await loadTemplateOr404(req, String(req.params.id ?? ''));
    res.json({ data: { template: serializeFull(row) } });
  } catch (err) {
    next(err);
  }
});

/* ─── POST / — create (admin) ────────────────────────────────────────────── */

/* mjmlSource accepts arbitrary JSON — the editor's IMjmlNode tree. Server
   doesn't validate the tree shape beyond "must be an object", since the
   render API (/getHtml) is the canonical validator. */
const createBody = z.object({
  name:       z.string().trim().min(1).max(120),
  category:   z.string().trim().max(40).optional(),
  mjmlSource: z.unknown().optional(),                  // tree; if omitted, FE sends a fresh tree
}).strict();

templatesRouter.post('/', requireAuth(), requireRole('admin'), requireClientScope, async (req, res, next) => {
  try {
    const body = createBody.parse(req.body);
    const clientId = await assertClientExists(req);
    const agencyId = req.auth!.agency_id;
    const userId   = req.auth!.sub;

    if (body.mjmlSource === undefined || body.mjmlSource === null) {
      throw badRequest('mjml_required', 'mjmlSource is required on create', { field: 'mjmlSource' });
    }

    const cleanTree = stripTreeForPersistence(body.mjmlSource);

    const created = await prisma.template.create({
      data: {
        agencyId,
        clientId,
        name:       body.name,
        category:   body.category ?? null,
        mjmlSource: cleanTree as Prisma.InputJsonValue,
        createdBy:  userId,
      },
      select: TEMPLATE_FULL_SELECT,
    });

    writeAudit({
      agencyId,
      actorUserId: userId,
      action:      'template.created',
      targetType:  'template',
      targetId:    created.id,
      metadata:    { clientId, name: created.name },
      req,
    });

    res.status(201).json({ data: { template: serializeFull(created) } });
  } catch (err) {
    next(err);
  }
});

/* ─── PATCH /:id — update (admin) ────────────────────────────────────────── */

const updateBody = z.object({
  name:         z.string().trim().min(1).max(120).optional(),
  category:     z.string().trim().max(40).nullable().optional(),
  mjmlSource:   z.unknown().optional(),
  archived:     z.boolean().optional(),
  /* thumbnailUrl is set by the frontend's background thumbnail-generation
     pipeline after save (compile MJML → screenshot iframe → upload to
     Cloudinary). It's a separate "silent" PATCH so it doesn't trigger
     toasts or block the user. URL is Cloudinary-hosted; we don't
     validate the host but cap length to prevent abuse. */
  thumbnailUrl: z.url().max(2000).nullable().optional(),
}).strict();

templatesRouter.patch('/:id', requireAuth(), requireRole('admin'), requireClientScope, async (req, res, next) => {
  try {
    const body = updateBody.parse(req.body);
    await assertClientExists(req);
    const existing = await loadTemplateOr404(req, String(req.params.id ?? ''));
    const agencyId = req.auth!.agency_id;
    const userId   = req.auth!.sub;

    const data: Prisma.TemplateUpdateInput = {};
    const changes: Record<string, unknown> = {};

    if (body.name !== undefined && body.name !== existing.name) {
      data.name = body.name;
      changes.name = { from: existing.name, to: body.name };
    }
    if (body.category !== undefined && body.category !== existing.category) {
      data.category = body.category;
      changes.category = { from: existing.category, to: body.category };
    }
    if (body.mjmlSource !== undefined) {
      data.mjmlSource = stripTreeForPersistence(body.mjmlSource) as Prisma.InputJsonValue;
      changes.mjmlSource = true;          // don't log the full tree — just that it changed
    }
    if (body.archived !== undefined && body.archived !== existing.archived) {
      data.archived = body.archived;
      changes.archived = { from: existing.archived, to: body.archived };
    }
    if (body.thumbnailUrl !== undefined && body.thumbnailUrl !== existing.thumbnailUrl) {
      data.thumbnailUrl = body.thumbnailUrl;
      changes.thumbnailUrl = true;        // URL itself isn't interesting in audit
    }

    if (Object.keys(data).length === 0) {
      // Nothing changed — return the existing row without writing.
      return res.json({ data: { template: serializeFull(existing) } });
    }

    const updated = await prisma.template.update({
      where: { id: existing.id },
      data,
      select: TEMPLATE_FULL_SELECT,
    });

    writeAudit({
      agencyId,
      actorUserId: userId,
      action:      'template.updated',
      targetType:  'template',
      targetId:    updated.id,
      metadata:    { clientId: updated.clientId, changes } as unknown as Prisma.InputJsonValue,
      req,
    });

    res.json({ data: { template: serializeFull(updated) } });
  } catch (err) {
    next(err);
  }
});

/* ─── DELETE /:id — soft-archive (admin) ─────────────────────────────────── */

templatesRouter.delete('/:id', requireAuth(), requireRole('admin'), requireClientScope, async (req, res, next) => {
  try {
    await assertClientExists(req);
    const existing = await loadTemplateOr404(req, String(req.params.id ?? ''));
    const agencyId = req.auth!.agency_id;
    const userId   = req.auth!.sub;

    if (existing.archived) {
      // Already archived — no-op, idempotent.
      return res.json({ data: { template: serializeFull(existing) } });
    }

    const updated = await prisma.template.update({
      where: { id: existing.id },
      data:  { archived: true },
      select: TEMPLATE_FULL_SELECT,
    });

    writeAudit({
      agencyId,
      actorUserId: userId,
      action:      'template.archived',
      targetType:  'template',
      targetId:    updated.id,
      metadata:    { clientId: updated.clientId, name: updated.name },
      req,
    });

    res.json({ data: { template: serializeFull(updated) } });
  } catch (err) {
    next(err);
  }
});

/* ─── POST /:id/duplicate — clone (admin) ────────────────────────────────── */

templatesRouter.post('/:id/duplicate', requireAuth(), requireRole('admin'), requireClientScope, async (req, res, next) => {
  try {
    await assertClientExists(req);
    const source = await loadTemplateOr404(req, String(req.params.id ?? ''));
    const agencyId = req.auth!.agency_id;
    const userId   = req.auth!.sub;

    const created = await prisma.template.create({
      data: {
        agencyId,
        clientId:   source.clientId,
        name:       `${source.name} (copy)`,
        category:   source.category,
        mjmlSource: source.mjmlSource as Prisma.InputJsonValue,
        // Clones are NEVER starters — even if the source was. A client-owned
        // clone is just a regular template they can edit.
        isStarter:  false,
        createdBy:  userId,
      },
      select: TEMPLATE_FULL_SELECT,
    });

    writeAudit({
      agencyId,
      actorUserId: userId,
      action:      'template.duplicated',
      targetType:  'template',
      targetId:    created.id,
      metadata:    { clientId: created.clientId, sourceId: source.id, name: created.name },
      req,
    });

    res.status(201).json({ data: { template: serializeFull(created) } });
  } catch (err) {
    next(err);
  }
});

/* ─── POST /:id/test-send — send the saved template to one address ───────── */

/* Compile mjmlSource → HTML → ship via Resend. Auth is `requireAuth +
   requireClientScope` (NOT admin) — any team member with client access can
   verify their own work in a real inbox.

   Frontend contract: caller is expected to have SAVED the template first
   (the editor's "Send test" button auto-saves dirty templates before
   calling this route, so Cloudinary uploads complete and the persisted
   mjmlSource is the latest version). We don't accept a tree in the body —
   keeps the endpoint contract small and the "send what's saved" semantics
   honest.

   Resend constraint note: with the default `onboarding@resend.dev` sender
   and no verified domain, Resend ONLY delivers to the email used at signup.
   Other recipients will 403. The error bubbles to the frontend toast. */

const testSendBody = z.object({
  toEmail:  z.email({ message: 'Must be a valid email address.' }),
  subject:  z.string().min(1).max(200).optional(),
});

templatesRouter.post('/:id/test-send', requireAuth(), requireClientScope, async (req, res, next) => {
  try {
    const body = testSendBody.parse(req.body);
    await assertClientExists(req);
    const template = await loadTemplateOr404(req, String(req.params.id ?? ''));
    const agencyId = req.auth!.agency_id;
    const userId   = req.auth!.sub;

    /* Look up the caller's email to use as Reply-To. The JWT carries only
       the user id; we hit the users table for the address. If the lookup
       fails (deleted user, race), we proceed without replyTo — the test
       still sends, replies just won't bounce back to the user. */
    const user = await prisma.user.findUnique({
      where:  { id: userId },
      select: { email: true },
    });

    /* mjmlSource is JSON in the DB — cast to the shape mjml2htmlProcessed
       expects. The wrapper mutates the tree in place (transformSocialToRaw),
       so we don't need to clone; the in-memory copy is throwaway. */
    const compiled = mjml2htmlProcessed(template.mjmlSource);
    if (!compiled.html) {
      return next(badRequest('mjml_compile_failed', 'Template did not compile to HTML. Check the editor for errors.'));
    }
    if (compiled.errors?.length) {
      // Log but don't block — MJML's "errors" array commonly contains warnings
      // (missing alt text, unrecognized attribute) that still produce valid HTML.
      console.warn(`[test-send] template ${template.id} compiled with ${compiled.errors.length} warning(s)`);
    }

    const subject = body.subject?.trim() || `[Test] ${template.name}`;

    let messageId: string;
    try {
      const result = await sendRawHtml({
        to:      body.toEmail,
        subject,
        html:    compiled.html,
        replyTo: user?.email,
      });
      messageId = result.messageId;
    } catch (err) {
      // Resend rejection (unverified domain, invalid recipient, throttle, etc.)
      // Surface a 400 with the reason so the frontend toast can show the cause.
      const reason = err instanceof Error ? err.message : 'Unknown email send error';
      return next(badRequest('email_send_failed', `Email send failed: ${reason}`));
    }

    writeAudit({
      agencyId,
      actorUserId: userId,
      action:      'template.test_sent',
      targetType:  'template',
      targetId:    template.id,
      metadata:    {
        clientId:  template.clientId,
        toEmail:   body.toEmail,
        subject,
        messageId,
        // NOT the html — would inflate the audit table for no observability gain
      },
      req,
    });

    res.json({ data: { messageId, to: body.toEmail, subject } });
  } catch (err) {
    next(err);
  }
});
