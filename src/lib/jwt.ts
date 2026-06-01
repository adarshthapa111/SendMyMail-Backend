import jwt from 'jsonwebtoken';
import { nanoid } from 'nanoid';

/* JWT shape — mirrors doc/architecture/auth-flow-and-schema.md §7.
   The server is authoritative on every claim; client never asserts them. */
export interface AuthClaims {
  sub: string;            // user id
  agency_id: string;      // user's current agency
  role: 'owner' | 'admin' | 'member' | 'viewer';
  scope:
    | { type: 'all' }
    | { type: 'clients'; ids: string[] };
  email_verified: boolean;
  agency_setup: boolean;  // has the agency completed /workspace-setup?
  iat: number;
  exp: number;
  jti: string;            // unique id — preps for future revocation table
}

const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  throw new Error('JWT_SECRET env var is required');
}
const JWT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

type IssueInput = Omit<AuthClaims, 'iat' | 'exp' | 'jti'>;

export function issueJwt(claims: IssueInput): string {
  return jwt.sign({ ...claims, jti: `jwt_${nanoid(16)}` }, SECRET as string, {
    algorithm: 'HS256',
    expiresIn: JWT_TTL_SECONDS,
  });
}

export function verifyJwt(token: string): AuthClaims {
  const decoded = jwt.verify(token, SECRET as string, { algorithms: ['HS256'] });
  if (typeof decoded === 'string') {
    throw new Error('Invalid JWT payload (expected object)');
  }
  return decoded as AuthClaims;
}
