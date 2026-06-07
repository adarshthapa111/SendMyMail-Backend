import { Resend } from 'resend';

/**
 * Shared Resend SDK singleton.
 *
 * Before feature-send-hardening: `new Resend(RESEND_API_KEY)` was
 * instantiated inline in src/lib/email.ts. Now that domain verification
 * also needs the SDK (for resend.domains.*), we extract a single
 * shared instance so both subsystems use the same client + same API
 * key.
 *
 * Why singleton: the Resend SDK constructor is cheap (just stores the
 * key), but having multiple instances would mean multiple separate
 * connection pools — wasteful for what's already a thin REST wrapper.
 *
 * Returns null if no key is set. Callers (lib/email's dispatch, the
 * sending-domains router, etc.) check for null and either fall back
 * to a console stub (transactional sends) or surface a 500 (admin
 * operations like domain.create — the agency owner needs to set up
 * Resend before they can verify a domain).
 */
const RESEND_KEY = process.env.RESEND_API_KEY;

export const resend: Resend | null = RESEND_KEY ? new Resend(RESEND_KEY) : null;

/**
 * Helper for routes that hard-require Resend to be configured.
 * Throws if not set; caller catches and 500s.
 */
export function requireResend(): Resend {
  if (!resend) {
    throw new Error('RESEND_API_KEY is not configured. Set it in the backend .env to use sending domains.');
  }
  return resend;
}
