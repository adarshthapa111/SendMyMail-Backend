import crypto from 'crypto';

/**
 * HMAC-signed tokens for engagement tracking.
 *
 * Two distinct token formats so the signatures can't be cross-used
 * (an open token can never be replayed as a click token, and vice
 * versa). Both reuse JWT_SECRET (same convention as the unsubscribe
 * tokens — see src/lib/unsubscribe-token.ts).
 *
 * Format: base64url(JSON.stringify(payload)) + '.' + base64url(HMAC-SHA256(payload, secret))
 * The signing "domain" is a 1-char prefix in the payload:
 *   { t: 'o', sendId } → open
 *   { t: 'c', sendId, url } → click
 * This guards against payload-shape collision between the two.
 *
 * NO EXPIRY. Recipients click old emails years later — the link should
 * still log the event. Rotating JWT_SECRET invalidates all tokens as
 * a side effect, which is the "kill switch" if we ever need one.
 *
 * Click tokens carry the full URL in-payload (not encrypted, just
 * signed). The URL is already in the email body — we're proving the
 * URL hasn't been tampered with, not hiding it. Prevents anyone from
 * crafting click tokens that redirect to phishing pages.
 */

interface OpenPayload  { t: 'o'; sendId: string; }
interface ClickPayload { t: 'c'; sendId: string; url: string; }

const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  throw new Error('JWT_SECRET env var is required for tracking-token signing');
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

function sign(payload: OpenPayload | ClickPayload): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf-8'));
  const sig  = b64url(
    crypto.createHmac('sha256', SECRET_BUF).update(body).digest(),
  );
  return `${body}.${sig}`;
}

function verify(token: string): OpenPayload | ClickPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;

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
    if (decoded.t !== 'o' && decoded.t !== 'c') return null;
    if (typeof decoded.sendId !== 'string' || !decoded.sendId) return null;
    if (decoded.t === 'c' && (typeof decoded.url !== 'string' || !decoded.url)) return null;
    return decoded as OpenPayload | ClickPayload;
  } catch {
    return null;
  }
}

export function signOpenToken(sendId: string): string {
  return sign({ t: 'o', sendId });
}

export function signClickToken(sendId: string, url: string): string {
  return sign({ t: 'c', sendId, url });
}

export function verifyOpenToken(token: string): { sendId: string } | null {
  const payload = verify(token);
  if (!payload || payload.t !== 'o') return null;
  return { sendId: payload.sendId };
}

export function verifyClickToken(token: string): { sendId: string; url: string } | null {
  const payload = verify(token);
  if (!payload || payload.t !== 'c') return null;
  return { sendId: payload.sendId, url: payload.url };
}
