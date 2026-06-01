import type { Request, Response, NextFunction } from 'express';
import { verifyJwt, type AuthClaims } from '../lib/jwt';
import { unauthorized, forbidden, notFound } from '../lib/errors';

/* requireAuth — extract + verify Bearer JWT, attach to req.auth.
   Reject 401 if missing/invalid/expired.
   Optionally set `allowUnverified` to skip the email-verified check (used by /verify itself). */
export function requireAuth(opts?: { allowUnverified?: boolean; allowUnsetupAgency?: boolean }) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      return next(unauthorized());
    }
    const token = header.slice(7).trim();
    let claims: AuthClaims;
    try {
      claims = verifyJwt(token);
    } catch {
      return next(unauthorized('invalid_token', 'Your session has expired. Please sign in again.'));
    }

    if (!opts?.allowUnverified && !claims.email_verified) {
      return next(forbidden('email_not_verified', 'Please verify your email first.'));
    }
    if (!opts?.allowUnsetupAgency && !claims.agency_setup) {
      return next(forbidden('agency_setup_incomplete', 'Please complete your workspace setup.'));
    }

    req.auth = claims;
    next();
  };
}

/* requireRole — ensure the authed user's role meets the minimum.
   Role hierarchy: viewer < member < admin < owner. */
const ROLE_RANK = { viewer: 0, member: 1, admin: 2, owner: 3 } as const;

export function requireRole(min: AuthClaims['role']) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) return next(unauthorized());
    if (ROLE_RANK[req.auth.role] < ROLE_RANK[min]) {
      return next(forbidden('insufficient_role', `This action requires the ${min} role or above.`));
    }
    next();
  };
}

/* requireClientScope — ensure the authed user has access to the :clientId in the URL.
   - If scope.type === 'all' → always allowed.
   - If scope.type === 'clients' → :clientId must be in scope.ids.
   - 404 (not 403) on out-of-scope — never leak that the client exists in another agency. */
export function requireClientScope(req: Request, _res: Response, next: NextFunction): void {
  if (!req.auth) return next(unauthorized());
  const raw = req.params.clientId;
  const clientId = typeof raw === 'string' ? raw : undefined;
  if (!clientId) return next(notFound());
  if (req.auth.scope.type === 'all') return next();
  if (req.auth.scope.ids.includes(clientId)) return next();
  return next(notFound()); // intentionally 404, not 403 — see api-conventions §4
}
