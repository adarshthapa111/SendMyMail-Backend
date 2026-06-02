import jwt from 'jsonwebtoken';
import { nanoid } from 'nanoid';

/* Short-lived signed state for OAuth flows.
   The `state` URL param sent to Google is a JWT containing a random nonce + any
   contextual data we need on the callback (e.g. an invitation token if the user
   clicked "Continue with Google" on /invite/:token). Carrying state in a signed
   JWT avoids needing express-session or cookies. */

interface OAuthState {
  nonce: string;
  invite?: string;     // optional invitation token if the OAuth flow was started from /invite/:token
  iat: number;
  exp: number;
}

const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  throw new Error('JWT_SECRET env var is required (oauthState)');
}
const STATE_TTL_SECONDS = 10 * 60; // 10 min

export function packOAuthState(opts: { invite?: string } = {}): string {
  return jwt.sign(
    { nonce: nanoid(16), ...(opts.invite ? { invite: opts.invite } : {}) },
    SECRET as string,
    { algorithm: 'HS256', expiresIn: STATE_TTL_SECONDS },
  );
}

export function unpackOAuthState(state: string): OAuthState {
  const decoded = jwt.verify(state, SECRET as string, { algorithms: ['HS256'] });
  if (typeof decoded === 'string') {
    throw new Error('Invalid OAuth state');
  }
  return decoded as OAuthState;
}
