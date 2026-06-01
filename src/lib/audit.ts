import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';

interface AuditInput {
  agencyId: string;
  actorUserId?: string | null;
  action: string;                // e.g. 'auth.login' / 'team.invite_sent'
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Prisma.InputJsonValue;
  req?: Request;                  // if passed, IP + user-agent get auto-captured
}

/* Writes one row to audit_log. Fire-and-forget — never blocks the response.
   If the audit insert fails, we swallow the error + log to console so the
   main request still succeeds (audit is for observability, not correctness). */
export function writeAudit(input: AuditInput): void {
  const ip = input.req ? (input.req.headers['x-forwarded-for']?.toString().split(',')[0].trim() || input.req.ip) : undefined;
  const userAgent = input.req?.headers['user-agent']?.toString();

  prisma.auditLog
    .create({
      data: {
        agencyId:    input.agencyId,
        actorUserId: input.actorUserId ?? null,
        action:      input.action,
        targetType:  input.targetType ?? null,
        targetId:    input.targetId ?? null,
        metadata:    input.metadata ?? undefined,
        ip:          ip ?? null,
        userAgent:   userAgent ?? null,
      },
    })
    .catch((err) => {
      console.error('[audit] failed to write:', err);
    });
}
