import rateLimit from 'express-rate-limit';
import { tooManyRequests } from '../lib/errors';

/* Preset rate limiters. All use in-memory storage (single-instance backend OK for V1);
   swap to Redis when we scale horizontally. */

const handler = (_req: unknown, _res: unknown, next: unknown) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (next as any)(tooManyRequests());
};

/* Signup — protects against bot signups + DB write storms. */
export const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,            // 1 hour
  limit: 5,                             // 5 signups per IP per hour
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

/* Login — 10 attempts per IP per 15 min on TOP of per-account lockout
   (account locks after 5 failed attempts via users.failed_login_count + locked_until). */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

/* Forgot password — same low-rate as login. Generic 200 prevents enumeration regardless. */
export const forgotLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

/* Verify code — 10 attempts per IP per 15 min (per-account attempt count
   handled separately on the email_verifications row). */
export const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

/* Invite resend — 1 per 5 min per IP (per-invite limit is also enforced on the invitations row). */
export const resendLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});
