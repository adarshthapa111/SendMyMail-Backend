/* Extend Express's Request type with our auth claims + request id. */
import type { AuthClaims } from '../lib/jwt';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Decoded JWT claims — populated by the `requireAuth` middleware. */
      auth?: AuthClaims;
      /** Trace id — stamped by the `requestId` middleware. */
      request_id?: string;
    }
  }
}

export {};
