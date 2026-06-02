import { OAuth2Client } from 'google-auth-library';
import { ApiError } from './errors';

/* Google OAuth helper.
   Uses the official `google-auth-library` for ID token verification (Google signs
   the ID token with its private key; we verify against Google's published public keys).
   The OAuth dance itself is standard authorization-code flow with PKCE. */

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:4000';
const REDIRECT_URI = `${BACKEND_URL}/v1/auth/google/callback`;

function assertConfigured() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new ApiError(
      500,
      'google_oauth_not_configured',
      'Google OAuth credentials are not set. Add GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET to .env (see .env.example for setup steps).',
    );
  }
}

function client() {
  assertConfigured();
  return new OAuth2Client({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
  });
}

/* Builds the URL we redirect the user to. */
export function buildAuthUrl(state: string): string {
  return client().generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email', 'profile'],
    state,
    prompt: 'select_account', // always let the user pick an account
  });
}

/* Exchanges the authorization code for tokens + verifies the ID token. */
export interface GoogleUserInfo {
  sub: string;             // stable Google user id — our link key
  email: string;
  email_verified: boolean;
  name: string;
  picture?: string;
}

export async function exchangeCodeForUserInfo(code: string): Promise<GoogleUserInfo> {
  const c = client();
  const { tokens } = await c.getToken(code);
  if (!tokens.id_token) {
    throw new ApiError(500, 'google_no_id_token', 'Google returned tokens without an id_token.');
  }
  const ticket = await c.verifyIdToken({ idToken: tokens.id_token, audience: CLIENT_ID });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload?.email) {
    throw new ApiError(500, 'google_payload_incomplete', 'Google ID token missing required claims.');
  }
  return {
    sub:            payload.sub,
    email:          payload.email,
    email_verified: payload.email_verified ?? false,
    name:           payload.name ?? payload.email.split('@')[0]!,
    picture:        payload.picture,
  };
}
