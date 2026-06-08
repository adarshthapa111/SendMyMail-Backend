import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { issueJwt } from '../lib/jwt';
import { hashPassword, verifyPassword, validatePasswordStrength } from '../lib/passwords';
import {
  generateUrlToken,
  hashToken,
  generateEmailVerificationCode,
} from '../lib/tokens';
import {
  sendVerificationCode,
  sendPasswordReset,
} from '../lib/email';
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  gone,
  unauthorized,
} from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requireAuth } from '../middleware/auth';
import {
  signupLimiter,
  loginLimiter,
  forgotLimiter,
  verifyLimiter,
} from '../middleware/rateLimit';
import { buildAuthUrl, exchangeCodeForUserInfo } from '../lib/google';
import { packOAuthState, unpackOAuthState } from '../lib/oauthState';

export const authRouter = Router();

/* ─── Helpers ────────────────────────────────────────────────────────────── */

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;
const VERIFICATION_TTL_MIN = 15;
const VERIFICATION_MAX_ATTEMPTS = 5;
const PASSWORD_RESET_TTL_HOURS = 1;

function issueJwtForUser(user: { id: string; agencyId: string; role: 'owner' | 'admin' | 'member' | 'viewer'; scopeType: 'all' | 'clients'; emailVerified: boolean }, agency: { setupComplete: boolean }, scopeIds: string[] = []) {
  return issueJwt({
    sub: user.id,
    agency_id: user.agencyId,
    role: user.role,
    scope: user.scopeType === 'all' ? { type: 'all' } : { type: 'clients', ids: scopeIds },
    email_verified: user.emailVerified,
    agency_setup: agency.setupComplete,
  });
}

/* Generic 200 — used by /forgot to prevent email enumeration. */
const OK_GENERIC = { ok: true } as const;

/* ─── POST /v1/auth/signup ───────────────────────────────────────────────── */

const signupBody = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1), // strength checked separately so the error code is specific
});

authRouter.post('/signup', signupLimiter, async (req, res, next) => {
  try {
    const body = signupBody.parse(req.body);

    // Strength check with specific error
    const strength = validatePasswordStrength(body.password);
    if (!strength.ok) {
      throw badRequest('weak_password', strength.reason, { field: 'password' });
    }

    // Globally unique email — see auth-flow-and-schema.md §9
    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) {
      throw conflict('email_already_registered', 'An account with this email already exists.', { field: 'email' });
    }

    // Create agency + owner user atomically
    const result = await prisma.$transaction(async (tx) => {
      const agency = await tx.agency.create({
        data: {
          name: `${body.name}'s agency`, // placeholder until /workspace-setup names it properly
          billingEmail: body.email,
          setupComplete: false,
        },
      });

      const passwordHash = await hashPassword(body.password);
      const user = await tx.user.create({
        data: {
          agencyId: agency.id,
          email: body.email,
          name: body.name,
          role: 'owner',
          scopeType: 'all',
          passwordHash,
          emailVerified: false,
        },
      });

      // Issue verification code
      const code = generateEmailVerificationCode();
      await tx.emailVerification.create({
        data: {
          userId: user.id,
          code,
          expiresAt: new Date(Date.now() + VERIFICATION_TTL_MIN * 60_000),
        },
      });

      return { user, agency, code };
    });

    // Send verification email (fire-and-forget; safe in dev stub)
    sendVerificationCode({ to: result.user.email, name: result.user.name, code: result.code });

    // Audit
    writeAudit({
      agencyId: result.agency.id,
      actorUserId: result.user.id,
      action: 'auth.signup',
      metadata: { source: 'email_password' },
      req,
    });

    const jwt = issueJwtForUser(result.user, result.agency);
    res.status(201).json({
      data: {
        user:   { id: result.user.id, email: result.user.email, name: result.user.name, role: result.user.role, emailVerified: false },
        agency: { id: result.agency.id, name: result.agency.name, setupComplete: false },
        jwt,
      },
    });
  } catch (err) {
    next(err);
  }
});

/* ─── POST /v1/auth/verify ───────────────────────────────────────────────── */

const verifyBody = z.object({
  code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
});

authRouter.post('/verify', verifyLimiter, requireAuth({ allowUnverified: true, allowUnsetupAgency: true }), async (req, res, next) => {
  try {
    const body = verifyBody.parse(req.body);
    const userId = req.auth!.sub;

    const verification = await prisma.emailVerification.findFirst({
      where: { userId, used: false },
      orderBy: { createdAt: 'desc' },
    });
    if (!verification) {
      throw notFound('no_pending_verification', 'No pending verification. Request a new code.');
    }
    if (verification.expiresAt < new Date()) {
      throw gone('verification_expired', 'This code has expired. Request a new one.');
    }
    if (verification.attempts >= VERIFICATION_MAX_ATTEMPTS) {
      throw forbidden('too_many_attempts', 'Too many wrong attempts. Request a new code.');
    }

    if (verification.code !== body.code) {
      await prisma.emailVerification.update({
        where: { id: verification.id },
        data: { attempts: { increment: 1 } },
      });
      throw badRequest('invalid_code', 'That code doesn\'t match. Please try again.', { field: 'code' });
    }

    const updated = await prisma.$transaction(async (tx) => {
      await tx.emailVerification.update({ where: { id: verification.id }, data: { used: true } });
      return tx.user.update({
        where: { id: userId },
        data: { emailVerified: true },
        include: { agency: true },
      });
    });

    writeAudit({
      agencyId: updated.agencyId,
      actorUserId: updated.id,
      action: 'auth.email_verified',
      req,
    });

    const jwt = issueJwtForUser(updated, updated.agency);
    res.json({ data: { jwt, user: { id: updated.id, emailVerified: true } } });
  } catch (err) {
    next(err);
  }
});

/* ─── GET /v1/auth/me ────────────────────────────────────────────────────── */

authRouter.get('/me', requireAuth({ allowUnverified: true, allowUnsetupAgency: true }), async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.auth!.sub },
      include: { agency: true },
    });
    if (!user) throw notFound('user_not_found');
    res.json({
      data: {
        user: serializeUser(user),
        agency: {
          id: user.agency.id,
          name: user.agency.name,
          country: user.agency.country,
          plan: user.agency.plan,
          setupComplete: user.agency.setupComplete,
          trialEndsAt: user.agency.trialEndsAt,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

/* ─── PATCH /v1/auth/me — feature-profile-settings V1 ────────────────────── */

/* All fields optional; only present-and-defined ones are written.
   Nullable so the UI can "clear" optional fields (avatar removal,
   jobTitle/bio/phone deletion). */
const updateMeBody = z.object({
  name:      z.string().trim().min(1, 'Name is required').max(100).optional(),
  avatarUrl: z.url().max(2000).nullable().optional(),
  jobTitle:  z.string().trim().max(80).nullable().optional(),
  bio:       z.string().trim().max(280).nullable().optional(),
  phone:     z.string().trim().max(30).nullable().optional(),
}).strict();

authRouter.patch('/me', requireAuth({ allowUnverified: true, allowUnsetupAgency: true }), async (req, res, next) => {
  try {
    const body = updateMeBody.parse(req.body);

    /* Prisma semantics: undefined = don't touch the column; null =
       SET NULL. Both valid for our nullable columns. Empty strings
       coerce to null (UI sometimes sends '' when a user clears a
       field but the input still passes through Zod min). */
    const data: Record<string, unknown> = {};
    if (body.name      !== undefined) data.name      = body.name;
    if (body.avatarUrl !== undefined) data.avatarUrl = body.avatarUrl;
    if (body.jobTitle  !== undefined) data.jobTitle  = body.jobTitle === '' ? null : body.jobTitle;
    if (body.bio       !== undefined) data.bio       = body.bio      === '' ? null : body.bio;
    if (body.phone     !== undefined) data.phone     = body.phone    === '' ? null : body.phone;

    if (Object.keys(data).length === 0) {
      /* No-op PATCH — return current state without DB write. */
      const user = await prisma.user.findUnique({
        where:   { id: req.auth!.sub },
        include: { agency: true },
      });
      if (!user) throw notFound('user_not_found');
      return res.json({ data: { user: serializeUser(user) } });
    }

    const updated = await prisma.user.update({
      where: { id: req.auth!.sub },
      data,
      include: { agency: true },
    });

    writeAudit({
      agencyId:    updated.agencyId,
      actorUserId: updated.id,
      action:      'user.profile_updated',
      targetType:  'user',
      targetId:    updated.id,
      metadata:    { fields: Object.keys(data) },     // names only, never values
      req,
    });

    res.json({ data: { user: serializeUser(updated) } });
  } catch (err) {
    next(err);
  }
});

/* Shared user-serializer for both GET + PATCH /me responses. */
function serializeUser(user: import('@prisma/client').User) {
  return {
    id:            user.id,
    email:         user.email,
    name:          user.name,
    role:          user.role,
    emailVerified: user.emailVerified,
    avatarUrl:     user.avatarUrl,
    jobTitle:      user.jobTitle,
    bio:           user.bio,
    phone:         user.phone,
    createdAt:     user.createdAt.toISOString(),
    lastLoginAt:   user.lastLoginAt?.toISOString() ?? null,
  };
}

/* ─── POST /v1/auth/login ────────────────────────────────────────────────── */

const loginBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

authRouter.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const body = loginBody.parse(req.body);

    const user = await prisma.user.findUnique({
      where: { email: body.email },
      include: { agency: true, clientScopes: true },
    });

    // Generic credential error on any failure — prevents email enumeration
    const INVALID = unauthorized('invalid_credentials', 'Invalid email or password.');

    if (!user) {
      // Constant-time-ish: still do a hash op to avoid timing leak
      await verifyPassword(body.password, '$argon2id$v=19$m=65536,t=3,p=1$' + 'a'.repeat(22) + '$' + 'b'.repeat(43));
      throw INVALID;
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw forbidden('account_locked', `Account locked. Try again after ${user.lockedUntil.toISOString()}.`);
    }

    if (!user.passwordHash) {
      // OAuth-only user trying to sign in with password
      throw INVALID;
    }

    const ok = await verifyPassword(body.password, user.passwordHash);
    if (!ok) {
      const next = user.failedLoginCount + 1;
      const shouldLock = next >= MAX_FAILED_LOGINS;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: next,
          lockedUntil: shouldLock ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null,
        },
      });
      writeAudit({
        agencyId: user.agencyId,
        actorUserId: user.id,
        action: 'auth.failed_login',
        metadata: { attempt: next, locked: shouldLock },
        req,
      });
      throw INVALID;
    }

    // Success — reset counters, update last_login_at
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    writeAudit({
      agencyId: user.agencyId,
      actorUserId: user.id,
      action: 'auth.login',
      metadata: { source: 'email_password' },
      req,
    });

    const scopeIds = user.clientScopes.map((s) => s.clientId);
    const jwt = issueJwtForUser(user, user.agency, scopeIds);
    res.json({
      data: {
        user:   { id: user.id, email: user.email, name: user.name, role: user.role, emailVerified: user.emailVerified },
        agency: { id: user.agency.id, name: user.agency.name, setupComplete: user.agency.setupComplete },
        jwt,
      },
    });
  } catch (err) {
    next(err);
  }
});

/* ─── POST /v1/auth/logout ───────────────────────────────────────────────── */

authRouter.post('/logout', requireAuth({ allowUnverified: true, allowUnsetupAgency: true }), async (req, res, next) => {
  try {
    writeAudit({
      agencyId: req.auth!.agency_id,
      actorUserId: req.auth!.sub,
      action: 'auth.logout',
      req,
    });
    // Stateless JWT — client just discards the token. (Revocation table is a future PR.)
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/* ─── POST /v1/auth/forgot ───────────────────────────────────────────────── */

const forgotBody = z.object({
  email: z.string().trim().toLowerCase().email(),
});

authRouter.post('/forgot', forgotLimiter, async (req, res, next) => {
  try {
    const body = forgotBody.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });

    // Silent success — never leak whether the email exists
    if (!user) return res.json(OK_GENERIC);

    const raw = generateUrlToken();
    const tokenHash = hashToken(raw);
    await prisma.passwordReset.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_HOURS * 60 * 60_000),
      },
    });

    sendPasswordReset({ to: user.email, name: user.name, token: raw });

    writeAudit({
      agencyId: user.agencyId,
      actorUserId: user.id,
      action: 'auth.password_reset_requested',
      req,
    });

    res.json(OK_GENERIC);
  } catch (err) {
    next(err);
  }
});

/* ─── POST /v1/auth/reset/:token ─────────────────────────────────────────── */

const resetBody = z.object({
  password: z.string().min(1),
});

authRouter.post('/reset/:token', async (req, res, next) => {
  try {
    const raw = req.params.token;
    const tokenHash = hashToken(raw);

    const body = resetBody.parse(req.body);
    const strength = validatePasswordStrength(body.password);
    if (!strength.ok) {
      throw badRequest('weak_password', strength.reason, { field: 'password' });
    }

    const reset = await prisma.passwordReset.findUnique({ where: { tokenHash } });
    if (!reset) throw notFound('reset_token_invalid', 'This reset link is invalid.');
    if (reset.used) throw gone('reset_token_used', 'This reset link has already been used.');
    if (reset.expiresAt < new Date()) {
      throw gone('reset_token_expired', 'This reset link has expired. Request a new one.');
    }

    const newHash = await hashPassword(body.password);
    const user = await prisma.$transaction(async (tx) => {
      await tx.passwordReset.update({ where: { id: reset.id }, data: { used: true } });
      return tx.user.update({
        where: { id: reset.userId },
        data: { passwordHash: newHash, failedLoginCount: 0, lockedUntil: null },
      });
    });

    writeAudit({
      agencyId: user.agencyId,
      actorUserId: user.id,
      action: 'auth.password_reset',
      req,
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ─── GET /v1/auth/google/start ──────────────────────────────────────────── */
/* Begins OAuth — optionally carrying an invite token in `?invite=<token>` so
   the callback can accept the invitation after the OAuth dance completes. */

authRouter.get('/google/start', (req, res, next) => {
  try {
    const invite = typeof req.query.invite === 'string' ? req.query.invite : undefined;
    const state = packOAuthState({ invite });
    const url = buildAuthUrl(state);
    res.redirect(url);
  } catch (err) {
    next(err);
  }
});

/* ─── GET /v1/auth/google/callback ───────────────────────────────────────── */
/* Decision tree per doc/architecture/auth-flow-and-schema.md §3:
     1. Existing oauth_identities row → sign in
     2. Email exists (no OAuth row yet) → auto-link Google + sign in
     3. Email doesn't exist + no invite → create new agency + Owner user
     4. Email doesn't exist + invite token → accept invite (handled like /accept) */

const APP_URL = process.env.APP_URL || 'http://localhost:5173';

function redirectWithJwt(res: import('express').Response, jwt: string) {
  // Redirect to frontend with JWT in the URL fragment (fragment never goes to server).
  res.redirect(`${APP_URL}/auth/google/done#jwt=${encodeURIComponent(jwt)}`);
}

function redirectWithError(res: import('express').Response, code: string, message: string) {
  res.redirect(`${APP_URL}/auth/google/done#error=${encodeURIComponent(code)}&message=${encodeURIComponent(message)}`);
}

authRouter.get('/google/callback', async (req, res, next) => {
  try {
    const code = typeof req.query.code === 'string' ? req.query.code : undefined;
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    if (!code || !state) {
      return redirectWithError(res, 'oauth_bad_request', 'Missing code or state parameter.');
    }

    // Verify state (rejects expired / tampered)
    let inviteToken: string | undefined;
    try {
      const unpacked = unpackOAuthState(state);
      inviteToken = unpacked.invite;
    } catch {
      return redirectWithError(res, 'oauth_state_invalid', 'Sign-in attempt expired. Please try again.');
    }

    // Exchange code → user info from Google
    const g = await exchangeCodeForUserInfo(code);
    if (!g.email_verified) {
      return redirectWithError(res, 'oauth_email_unverified', 'Your Google email isn\'t verified.');
    }

    // ─── BRANCH 1: existing OAuth identity? → sign in ──────────────────────
    const oauthRow = await prisma.oAuthIdentity.findUnique({
      where: { provider_providerUid: { provider: 'google', providerUid: g.sub } },
      include: { user: { include: { agency: true, clientScopes: true } } },
    });

    if (oauthRow) {
      const user = oauthRow.user;
      await prisma.$transaction([
        prisma.oAuthIdentity.update({ where: { id: oauthRow.id }, data: { lastUsedAt: new Date() } }),
        prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }),
      ]);
      writeAudit({
        agencyId: user.agencyId,
        actorUserId: user.id,
        action: 'auth.login',
        metadata: { source: 'google' },
        req,
      });
      const scopeIds = user.clientScopes.map((s) => s.clientId);
      const jwt = issueJwtForUser(user, user.agency, scopeIds);
      return redirectWithJwt(res, jwt);
    }

    // ─── BRANCH 2: existing user with this email? → auto-link ──────────────
    const existing = await prisma.user.findUnique({
      where: { email: g.email },
      include: { agency: true, clientScopes: true },
    });

    if (existing) {
      if (!existing.emailVerified) {
        return redirectWithError(res, 'email_unverified_locally', 'Complete email verification first, then link Google.');
      }
      await prisma.$transaction([
        prisma.oAuthIdentity.create({
          data: {
            userId:        existing.id,
            provider:      'google',
            providerUid:   g.sub,
            providerEmail: g.email,
            lastUsedAt:    new Date(),
          },
        }),
        prisma.user.update({ where: { id: existing.id }, data: { lastLoginAt: new Date() } }),
      ]);
      writeAudit({
        agencyId: existing.agencyId,
        actorUserId: existing.id,
        action: 'auth.google_linked',
        req,
      });
      const scopeIds = existing.clientScopes.map((s) => s.clientId);
      const jwt = issueJwtForUser(existing, existing.agency, scopeIds);
      return redirectWithJwt(res, jwt);
    }

    // ─── BRANCH 3a: brand-new + has invite token → accept invitation ───────
    if (inviteToken) {
      const tokenHash = hashToken(inviteToken);
      const invite = await prisma.invitation.findUnique({ where: { tokenHash } });
      if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt < new Date()) {
        return redirectWithError(res, 'invitation_invalid', 'This invitation is invalid, expired, or already accepted.');
      }
      if (invite.email.toLowerCase() !== g.email.toLowerCase()) {
        return redirectWithError(res, 'invitation_email_mismatch', `Signed in with ${g.email} but invited as ${invite.email}.`);
      }

      const scope = invite.scope as { type: 'all' } | { type: 'clients'; ids: string[] };
      const result = await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            agencyId:      invite.agencyId,
            email:         g.email,
            name:          g.name,
            role:          invite.role,
            scopeType:     scope.type,
            emailVerified: true,
            passwordHash:  null,
          },
        });
        await tx.oAuthIdentity.create({
          data: {
            userId:        user.id,
            provider:      'google',
            providerUid:   g.sub,
            providerEmail: g.email,
            lastUsedAt:    new Date(),
          },
        });
        if (scope.type === 'clients') {
          await tx.userClientScope.createMany({
            data: scope.ids.map((clientId) => ({ userId: user.id, clientId, grantedBy: invite.inviterUserId })),
          });
        }
        await tx.invitation.update({
          where: { id: invite.id },
          data: { acceptedAt: new Date(), acceptedUserId: user.id },
        });
        return tx.user.findUniqueOrThrow({ where: { id: user.id }, include: { agency: true, clientScopes: true } });
      });

      writeAudit({
        agencyId: invite.agencyId,
        actorUserId: result.id,
        action: 'team.invitation_accepted',
        targetType: 'invitation',
        targetId: invite.id,
        metadata: { role: invite.role, source: 'google' },
        req,
      });

      const scopeIds = result.clientScopes.map((s) => s.clientId);
      const jwt = issueJwtForUser(result, result.agency, scopeIds);
      return redirectWithJwt(res, jwt);
    }

    // ─── BRANCH 3b: brand-new + no invite → create new agency + Owner ──────
    const created = await prisma.$transaction(async (tx) => {
      const agency = await tx.agency.create({
        data: {
          name: `${g.name}'s agency`,
          billingEmail: g.email,
          setupComplete: false,
        },
      });
      const user = await tx.user.create({
        data: {
          agencyId:      agency.id,
          email:         g.email,
          name:          g.name,
          role:          'owner',
          scopeType:     'all',
          emailVerified: true,        // Google verified it
          passwordHash:  null,        // no password — OAuth-only
          avatarUrl:     g.picture ?? null,
          lastLoginAt:   new Date(),
        },
      });
      await tx.oAuthIdentity.create({
        data: {
          userId:        user.id,
          provider:      'google',
          providerUid:   g.sub,
          providerEmail: g.email,
          lastUsedAt:    new Date(),
        },
      });
      return { user, agency };
    });

    writeAudit({
      agencyId: created.agency.id,
      actorUserId: created.user.id,
      action: 'auth.signup',
      metadata: { source: 'google' },
      req,
    });

    const jwt = issueJwtForUser(created.user, created.agency);
    return redirectWithJwt(res, jwt);
  } catch (err) {
    next(err);
  }
});

/* ─── GET /v1/auth/invitations/:token — public, view invite details ──────── */

authRouter.get('/invitations/:token', async (req, res, next) => {
  try {
    const raw = typeof req.params.token === 'string' ? req.params.token : '';
    if (!raw) throw notFound('invitation_invalid', 'Invitation link is invalid.');
    const tokenHash = hashToken(raw);

    const invite = await prisma.invitation.findUnique({
      where: { tokenHash },
      include: { agency: true, inviter: true },
    });
    if (!invite)                      throw notFound('invitation_invalid', 'This invitation link is invalid or has been revoked.');
    if (invite.acceptedAt)            throw gone('invitation_already_accepted', 'You\'ve already accepted this invitation. Sign in to continue.');
    if (invite.revokedAt)             throw gone('invitation_revoked', 'This invitation was revoked by the inviter.');
    if (invite.expiresAt < new Date()) throw gone('invitation_expired', `This invitation expired on ${invite.expiresAt.toISOString()}.`);

    res.json({
      data: {
        agencyName:     invite.agency.name,
        inviterName:    invite.inviter?.name ?? null,
        inviterEmail:   invite.inviter?.email ?? null,
        inviteeEmail:   invite.email,
        role:           invite.role,
        scope:          invite.scope,
        note:           invite.note,
        expiresAt:      invite.expiresAt,
      },
    });
  } catch (err) {
    next(err);
  }
});

/* ─── POST /v1/auth/invitations/:token/accept — public, create user ──────── */

const acceptBody = z.object({
  name:     z.string().trim().min(1).max(100),
  password: z.string().min(1),
});

authRouter.post('/invitations/:token/accept', async (req, res, next) => {
  try {
    const raw = typeof req.params.token === 'string' ? req.params.token : '';
    if (!raw) throw notFound('invitation_invalid', 'Invitation link is invalid.');
    const tokenHash = hashToken(raw);

    const body = acceptBody.parse(req.body);
    const strength = validatePasswordStrength(body.password);
    if (!strength.ok) throw badRequest('weak_password', strength.reason, { field: 'password' });

    const invite = await prisma.invitation.findUnique({ where: { tokenHash } });
    if (!invite)                      throw notFound('invitation_invalid', 'This invitation link is invalid.');
    if (invite.acceptedAt)            throw gone('invitation_already_accepted', 'This invitation was already accepted.');
    if (invite.revokedAt)             throw gone('invitation_revoked', 'This invitation was revoked.');
    if (invite.expiresAt < new Date()) throw gone('invitation_expired', 'This invitation has expired.');

    // Email uniqueness guard (race-safe via DB constraint, but we also surface a clean error)
    const existing = await prisma.user.findUnique({ where: { email: invite.email } });
    if (existing) {
      throw conflict('email_already_registered', 'This email already has a SendMyMail account. Sign in to it first.', { field: 'email' });
    }

    const passwordHash = await hashPassword(body.password);
    const scope = invite.scope as { type: 'all' } | { type: 'clients'; ids: string[] };

    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          agencyId:      invite.agencyId,
          email:         invite.email,
          name:          body.name,
          role:          invite.role,
          scopeType:     scope.type,
          emailVerified: true,      // proven by access to the invite link in their email
          passwordHash,
        },
      });
      if (scope.type === 'clients') {
        await tx.userClientScope.createMany({
          data: scope.ids.map((clientId) => ({ userId: user.id, clientId, grantedBy: invite.inviterUserId })),
        });
      }
      await tx.invitation.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date(), acceptedUserId: user.id },
      });
      return tx.user.findUniqueOrThrow({ where: { id: user.id }, include: { agency: true, clientScopes: true } });
    });

    writeAudit({
      agencyId: invite.agencyId,
      actorUserId: result.id,
      action: 'team.invitation_accepted',
      targetType: 'invitation',
      targetId: invite.id,
      metadata: { role: invite.role, source: 'email_password' },
      req,
    });
    writeAudit({
      agencyId: invite.agencyId,
      actorUserId: result.id,
      action: 'auth.signup',
      metadata: { source: 'invitation' },
      req,
    });

    const scopeIds = result.clientScopes.map((s) => s.clientId);
    const jwt = issueJwtForUser(result, result.agency, scopeIds);
    res.status(201).json({
      data: {
        user:   { id: result.id, email: result.email, name: result.name, role: result.role, emailVerified: true },
        agency: { id: result.agency.id, name: result.agency.name, setupComplete: result.agency.setupComplete },
        jwt,
      },
    });
  } catch (err) {
    next(err);
  }
});
