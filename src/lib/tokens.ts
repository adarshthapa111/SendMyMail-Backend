import crypto from 'node:crypto';

/* Random URL-safe token (~32 bytes of entropy).
   Used for password reset + invitation tokens — the raw value lives ONLY in
   the email URL. The DB stores hashToken(raw) so a leaked row can't be replayed. */
export function generateUrlToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/* SHA-256 of the raw token. Verification: hash incoming → look up by hash. */
export function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/* 6-digit numeric code for email verification (lower entropy is OK — 15-min TTL, 5-attempt lock). */
export function generateEmailVerificationCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}
