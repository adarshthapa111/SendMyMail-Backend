import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { generateUrlToken, hashToken } from '../lib/tokens';
import { sendInvitation } from '../lib/email';
import { badRequest, conflict, forbidden, notFound, gone } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requireAuth, requireRole } from '../middleware/auth';
import { resendLimiter } from '../middleware/rateLimit';

export const invitationsRouter = Router();

const INVITE_TTL_DAYS = 7;
const RESEND_COOLDOWN_MS = 5 * 60 * 1000;
const ROLE_RANK = { viewer: 0, member: 1, admin: 2, owner: 3 } as const;

const scopeSchema = z.union([
  z.object({ type: z.literal('all') }),
  z.object({ type: z.literal('clients'), ids: z.array(z.string()).min(1) }),
]);

const inviteRoleSchema = z.enum(['admin', 'member', 'viewer']);

/* ─── POST /v1/team/invitations — create a pending invitation ───────────── */

const createBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  role:  inviteRoleSchema,
  scope: scopeSchema.default({ type: 'all' }),
  note:  z.string().max(500).optional(),
});

invitationsRouter.post(
  '/',
  requireAuth(),
  requireRole('admin'),
  async (req, res, next) => {
    try {
      const body = createBody.parse(req.body);

      // Admin cannot invite another Admin (only Owner can promote-via-invite)
      if (body.role === 'admin' && ROLE_RANK[req.auth!.role] < ROLE_RANK.owner) {
        throw forbidden('cannot_invite_admin', 'Only the Owner can invite Admins.');
      }
      // Admins must have scope=all (enforced at the role level, not in the schema)
      if (body.role === 'admin' && body.scope.type !== 'all') {
        throw badRequest('admin_must_have_all_scope', 'Admins always have access to all clients — scope must be "all".', { field: 'scope' });
      }
      // Inviter can't invite themselves
      if (body.email === req.auth!.sub) {
        throw badRequest('cannot_invite_self', 'You cannot invite yourself.', { field: 'email' });
      }

      // If a real user already exists with this email, reject (V1 = one user one agency)
      const existing = await prisma.user.findUnique({ where: { email: body.email } });
      if (existing) {
        throw conflict('email_already_registered', `${body.email} already has a SendMyMail account.`, { field: 'email' });
      }

      // If scope=clients, validate every clientId belongs to this agency
      if (body.scope.type === 'clients') {
        const clients = await prisma.client.findMany({
          where: { id: { in: body.scope.ids }, agencyId: req.auth!.agency_id },
          select: { id: true },
        });
        if (clients.length !== body.scope.ids.length) {
          throw badRequest('client_scope_invalid', 'One or more clientIds are not in your agency.', { field: 'scope' });
        }
      }

      // Mark any existing pending invitation for this (agency, email) as superseded
      await prisma.invitation.updateMany({
        where: {
          agencyId: req.auth!.agency_id,
          email: body.email,
          acceptedAt: null,
          revokedAt: null,
          supersededAt: null,
        },
        data: { supersededAt: new Date() },
      });

      const rawToken = generateUrlToken();
      const tokenHash = hashToken(rawToken);

      const invitation = await prisma.invitation.create({
        data: {
          agencyId:      req.auth!.agency_id,
          inviterUserId: req.auth!.sub,
          email:         body.email,
          role:          body.role,
          scope:         body.scope,
          tokenHash,
          expiresAt:     new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000),
          note:          body.note,
        },
        include: { agency: true, inviter: true },
      });

      sendInvitation({
        to:           body.email,
        inviterName:  invitation.inviter?.name ?? 'A teammate',
        agencyName:   invitation.agency.name,
        role:         body.role,
        token:        rawToken,
        note:         body.note,
      });

      writeAudit({
        agencyId: req.auth!.agency_id,
        actorUserId: req.auth!.sub,
        action: 'team.invite_sent',
        targetType: 'invitation',
        targetId: invitation.id,
        metadata: { invitee_email: body.email, role: body.role, scope: body.scope },
        req,
      });

      res.status(201).json({
        data: {
          id:        invitation.id,
          email:     invitation.email,
          role:      invitation.role,
          scope:     invitation.scope,
          expiresAt: invitation.expiresAt,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

/* ─── GET /v1/team/invitations — list pending invitations ───────────────── */

invitationsRouter.get(
  '/',
  requireAuth(),
  requireRole('admin'),
  async (req, res, next) => {
    try {
      const invitations = await prisma.invitation.findMany({
        where: {
          agencyId: req.auth!.agency_id,
          acceptedAt: null,
          revokedAt: null,
          supersededAt: null,
        },
        include: { inviter: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: 'desc' },
      });
      res.json({
        data: invitations.map((inv) => ({
          id:        inv.id,
          email:     inv.email,
          role:      inv.role,
          scope:     inv.scope,
          inviter:   inv.inviter,
          createdAt: inv.createdAt,
          expiresAt: inv.expiresAt,
        })),
      });
    } catch (err) {
      next(err);
    }
  },
);

/* ─── PATCH /v1/team/invitations/:id — edit role/scope of a pending invite ─ */

const patchBody = z.object({
  role:  inviteRoleSchema.optional(),
  scope: scopeSchema.optional(),
});

invitationsRouter.patch(
  '/:id',
  requireAuth(),
  requireRole('admin'),
  async (req, res, next) => {
    try {
      const id = req.params.id;
      if (typeof id !== 'string') throw notFound();
      const body = patchBody.parse(req.body);

      const invitation = await prisma.invitation.findFirst({
        where: { id, agencyId: req.auth!.agency_id },
      });
      if (!invitation) throw notFound('invitation_not_found');
      if (invitation.acceptedAt) throw gone('invitation_already_accepted', 'Can\'t edit — already accepted.');
      if (invitation.revokedAt)  throw gone('invitation_revoked', 'Can\'t edit — already revoked.');
      if (invitation.expiresAt < new Date()) throw gone('invitation_expired', 'Can\'t edit — already expired.');

      // Same rule as create — Admin → Admin invites only by Owner; Admin role forces scope=all
      const nextRole = body.role ?? invitation.role;
      const nextScope = body.scope ?? (invitation.scope as { type: 'all' } | { type: 'clients'; ids: string[] });
      if (nextRole === 'admin' && ROLE_RANK[req.auth!.role] < ROLE_RANK.owner) {
        throw forbidden('cannot_invite_admin', 'Only the Owner can promote an invitation to Admin.');
      }
      if (nextRole === 'admin' && nextScope.type !== 'all') {
        throw badRequest('admin_must_have_all_scope', 'Admins always have access to all clients.', { field: 'scope' });
      }

      const before = { role: invitation.role, scope: invitation.scope };
      const updated = await prisma.invitation.update({
        where: { id: invitation.id },
        data: { role: nextRole, scope: nextScope },
      });

      writeAudit({
        agencyId: req.auth!.agency_id,
        actorUserId: req.auth!.sub,
        action: 'team.invite_edited',
        targetType: 'invitation',
        targetId: invitation.id,
        metadata: { before, after: { role: nextRole, scope: nextScope } },
        req,
      });

      res.json({
        data: { id: updated.id, email: updated.email, role: updated.role, scope: updated.scope, expiresAt: updated.expiresAt },
      });
    } catch (err) {
      next(err);
    }
  },
);

/* ─── POST /v1/team/invitations/:id/resend — re-send email with same token ─ */

invitationsRouter.post(
  '/:id/resend',
  resendLimiter,
  requireAuth(),
  requireRole('admin'),
  async (req, res, next) => {
    try {
      const id = req.params.id;
      if (typeof id !== 'string') throw notFound();

      const invitation = await prisma.invitation.findFirst({
        where: { id, agencyId: req.auth!.agency_id },
        include: { agency: true, inviter: true },
      });
      if (!invitation) throw notFound('invitation_not_found');
      if (invitation.acceptedAt) throw gone('invitation_already_accepted', 'Already accepted — nothing to resend.');
      if (invitation.revokedAt)  throw gone('invitation_revoked', 'Already revoked — nothing to resend.');
      if (invitation.expiresAt < new Date()) throw gone('invitation_expired', 'Already expired — create a new invitation.');

      // Per-invitation cooldown (5 min)
      const lastUpdate = invitation.updatedAt ?? invitation.createdAt;
      if (Date.now() - new Date(lastUpdate).getTime() < RESEND_COOLDOWN_MS) {
        throw badRequest('resend_too_soon', 'Please wait a few minutes before resending.');
      }

      // We can't recover the raw token (we only stored the hash) — generate a new one,
      // rotate the hash. This is a deliberate trade-off: simpler than restoring the
      // original token, and an attacker would need the email anyway.
      const rawToken = generateUrlToken();
      const tokenHash = hashToken(rawToken);

      const updated = await prisma.invitation.update({
        where: { id: invitation.id },
        data: {
          tokenHash,
          expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000),
        },
      });

      sendInvitation({
        to:           invitation.email,
        inviterName:  invitation.inviter?.name ?? 'A teammate',
        agencyName:   invitation.agency.name,
        role:         invitation.role,
        token:        rawToken,
        note:         invitation.note ?? undefined,
      });

      writeAudit({
        agencyId: req.auth!.agency_id,
        actorUserId: req.auth!.sub,
        action: 'team.invite_resent',
        targetType: 'invitation',
        targetId: invitation.id,
        req,
      });

      res.json({ data: { id: updated.id, expiresAt: updated.expiresAt } });
    } catch (err) {
      next(err);
    }
  },
);

/* ─── POST /v1/team/invitations/:id/revoke ──────────────────────────────── */

invitationsRouter.post(
  '/:id/revoke',
  requireAuth(),
  requireRole('admin'),
  async (req, res, next) => {
    try {
      const id = req.params.id;
      if (typeof id !== 'string') throw notFound();

      const invitation = await prisma.invitation.findFirst({
        where: { id, agencyId: req.auth!.agency_id },
      });
      if (!invitation) throw notFound('invitation_not_found');
      if (invitation.acceptedAt) throw gone('invitation_already_accepted', 'Already accepted — can\'t revoke.');
      if (invitation.revokedAt)  return res.json({ data: { id: invitation.id, alreadyRevoked: true } });

      await prisma.invitation.update({
        where: { id: invitation.id },
        data: { revokedAt: new Date() },
      });

      writeAudit({
        agencyId: req.auth!.agency_id,
        actorUserId: req.auth!.sub,
        action: 'team.invite_revoked',
        targetType: 'invitation',
        targetId: invitation.id,
        metadata: { invitee_email: invitation.email },
        req,
      });

      res.json({ data: { id: invitation.id, revoked: true } });
    } catch (err) {
      next(err);
    }
  },
);
