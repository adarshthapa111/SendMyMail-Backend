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
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          emailVerified: user.emailVerified,
          avatarUrl: user.avatarUrl,
        },
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
