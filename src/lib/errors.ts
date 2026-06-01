import type { Request, Response, NextFunction } from 'express';
import { nanoid } from 'nanoid';
import { ZodError } from 'zod';

/* API error shape per doc/architecture/api-conventions.md §4:
   { error: { code, message, field?, details? }, request_id } */

export class ApiError extends Error {
  status: number;
  code: string;
  field?: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, opts?: { field?: string; details?: unknown }) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = opts?.field;
    this.details = opts?.details;
  }
}

/* Convenience throwers */
export const badRequest    = (code: string, message: string, opts?: { field?: string; details?: unknown }) =>
  new ApiError(400, code, message, opts);
export const unauthorized  = (code = 'unauthorized', message = 'Authentication required') =>
  new ApiError(401, code, message);
export const forbidden     = (code = 'forbidden', message = 'You don\'t have permission') =>
  new ApiError(403, code, message);
export const notFound      = (code = 'not_found', message = 'Resource not found') =>
  new ApiError(404, code, message);
export const conflict      = (code: string, message: string, opts?: { field?: string }) =>
  new ApiError(409, code, message, opts);
export const gone          = (code: string, message: string) =>
  new ApiError(410, code, message);
export const unprocessable = (code: string, message: string, opts?: { field?: string; details?: unknown }) =>
  new ApiError(422, code, message, opts);
export const tooManyRequests = (code = 'rate_limited', message = 'Too many requests') =>
  new ApiError(429, code, message);

/* Express middleware — always the LAST middleware. */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const request_id = (req as Request & { request_id?: string }).request_id ?? `req_${nanoid(12)}`;

  // Known ApiError → respond with its shape
  if (err instanceof ApiError) {
    const errorBody: { code: string; message: string; field?: string; details?: unknown } = {
      code: err.code,
      message: err.message,
    };
    if (err.field !== undefined) errorBody.field = err.field;
    if (err.details !== undefined) errorBody.details = err.details;
    res.status(err.status).json({ error: errorBody, request_id });
    return;
  }

  // Zod validation error → 422 with first issue surfaced as field-level error
  if (err instanceof ZodError) {
    const first = err.issues[0];
    res.status(422).json({
      error: {
        code:    'validation_failed',
        message: first?.message ?? 'Request validation failed',
        field:   first?.path?.join('.'),
        details: err.issues,
      },
      request_id,
    });
    return;
  }

  // Unknown error → log + generic 500 (never leak internals)
  console.error('[unhandled]', err);
  res.status(500).json({
    error: {
      code:    'server_error',
      message: 'Something went wrong. Please try again.',
    },
    request_id,
  });
}

/* Tiny middleware that stamps every request with a request_id for tracing.
   Surfaced in error responses + (later) logs. */
export function requestId(req: Request, _res: Response, next: NextFunction): void {
  (req as Request & { request_id: string }).request_id = `req_${nanoid(12)}`;
  next();
}
