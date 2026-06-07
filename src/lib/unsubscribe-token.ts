import crypto from 'crypto';

/**
 * HMAC-signed unsubscribe tokens.
 *
 * Format: base64url(JSON.stringify(payload)) + '.' + base64url(HMAC-SHA256(payload, JWT_SECRET))
 *
 * Design choices:
 *  - **Reuse JWT_SECRET** instead of a new env var. The secret exists, is
 *    long enough, and rotation already requires a deploy. Rotating JWT_SECRET
 *    invalidates every unsubscribe token ever issued — feature, not bug, if
 *    we ever need to reset.
 *  - **No expiry.** Recipients may click 2-year-old emails; the link should
 *    still work. Email links are durable infrastructure.
 *  - **Compact format.** Tokens are ~140 chars — short enough for clean
 *    `https://app/u/{token}` URLs in email footers.
 *  - **No replay prevention.** Idempotent unsubscribe means clicking twice
 *    is harmless; we don't need nonces.
 */

export interface UnsubPayload {
  contactId: string;            // may be empty string if the snapshot had stragglers (V2 manual lists)
  listId:    string;            // empty string OK — agency-wide suppression still applies
  agencyId:  string;
}

const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  throw new Error('JWT_SECRET env var is required for unsubscribe-token signing');
}

const SECRET_BUF = Buffer.from(SECRET, 'utf-8');

function b64url(buf: Buffer): string {
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

export function signUnsubToken(payload: UnsubPayload): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf-8'));
  const sig  = b64url(
    crypto.createHmac('sha256', SECRET_BUF).update(body).digest(),
  );
  return `${body}.${sig}`;
}

export function verifyUnsubToken(token: string): UnsubPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;

  /* Constant-time comparison to prevent timing attacks (low value
     here but cheap to do right). */
  const expectedSig = b64url(
    crypto.createHmac('sha256', SECRET_BUF).update(body).digest(),
  );
  const sigBuf      = Buffer.from(sig, 'utf-8');
  const expectedBuf = Buffer.from(expectedSig, 'utf-8');
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  try {
    const decoded = JSON.parse(b64urlDecode(body).toString('utf-8'));
    if (typeof decoded !== 'object' || decoded === null) return null;
    if (typeof decoded.contactId !== 'string') return null;
    if (typeof decoded.listId    !== 'string') return null;
    if (typeof decoded.agencyId  !== 'string' || !decoded.agencyId) return null;
    return decoded as UnsubPayload;
  } catch {
    return null;
  }
}
