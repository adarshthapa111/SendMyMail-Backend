import { requireResend } from './resend';
import { prisma } from './prisma';
import type { DomainStatus, SendingDomain } from '@prisma/client';

/**
 * Resend domains API wrapper.
 *
 * Resend handles the actual DNS verification — we just orchestrate:
 *   1. resend.domains.create({ name }) — returns DNS records
 *   2. (user adds records to their DNS provider)
 *   3. resend.domains.verify(id) — Resend re-checks DNS; returns updated status
 *   4. resend.domains.remove(id) — cleanup
 *
 * We store the Resend-issued records (jsonb) so the frontend can re-display
 * them without round-tripping to Resend. The status is the source of truth
 * on the Resend side; we mirror it locally for fast `findFirst` queries
 * during send (resolve the verified domain for the From address).
 */

/**
 * The shape of a Resend DNS record entry. Resend's TypeScript types
 * are loose, so we narrow to what we actually use.
 */
export interface ResendDnsRecord {
  record:   string;                  // "CNAME" | "TXT" | "MX" (sometimes "SPF")
  name:     string;                  // hostname to set, e.g. "send.mail.foo.com"
  type:     string;                  // record type as Resend reports it
  value:    string;                  // record value to set
  ttl?:     string | number;         // "Auto" or number of seconds
  priority?: number;                 // MX records
  status?:  string;                  // "pending" | "verified" | "not_started"
}

function mapResendStatus(resendStatus: string | undefined): DomainStatus {
  switch (resendStatus) {
    case 'verified':         return 'verified';
    case 'failed':           return 'failed';
    case 'temporary_failure': return 'failed';
    default:                 return 'pending';     // not_started, pending, anything else
  }
}

/**
 * Create a domain in Resend + persist it locally. Returns the local row.
 * Throws on Resend API errors.
 */
export async function createSendingDomain(opts: {
  agencyId: string;
  name:     string;
}): Promise<SendingDomain> {
  const client = requireResend();

  const result = await client.domains.create({ name: opts.name });
  if (result.error) {
    throw new Error(`Resend rejected the domain: ${result.error.message ?? 'unknown'}`);
  }
  const data = result.data;
  if (!data) {
    throw new Error('Resend returned no data when creating the domain.');
  }

  // `records` shape varies slightly by SDK version; cast to our narrowed type.
  const records = (data.records ?? []) as unknown as ResendDnsRecord[];

  return prisma.sendingDomain.create({
    data: {
      agencyId:      opts.agencyId,
      name:          opts.name,
      resendId:      data.id,
      status:        mapResendStatus(data.status as string | undefined),
      records:       records as unknown as object,    // jsonb
      lastCheckedAt: new Date(),
    },
  });
}

/**
 * Ask Resend to re-verify a domain. Updates the local row's status +
 * records + verifiedAt + lastCheckedAt. Returns the updated row.
 */
export async function refreshSendingDomain(row: SendingDomain): Promise<SendingDomain> {
  const client = requireResend();

  if (!row.resendId) {
    throw new Error('Sending domain has no resendId — cannot refresh.');
  }

  /* `resend.domains.verify` triggers a DNS check on Resend's side and
     returns the updated state. */
  const result = await client.domains.verify(row.resendId);
  if (result.error) {
    throw new Error(`Resend verify failed: ${result.error.message ?? 'unknown'}`);
  }

  /* After verify, fetch the full current state — Resend's verify response
     is minimal; get() returns the full record set with current statuses. */
  const fresh = await client.domains.get(row.resendId);
  if (fresh.error || !fresh.data) {
    throw new Error(`Resend get failed: ${fresh.error?.message ?? 'no data'}`);
  }

  const status  = mapResendStatus(fresh.data.status as string | undefined);
  const records = (fresh.data.records ?? []) as unknown as ResendDnsRecord[];

  return prisma.sendingDomain.update({
    where: { id: row.id },
    data: {
      status,
      records:       records as unknown as object,
      verifiedAt:    status === 'verified' && !row.verifiedAt ? new Date() : row.verifiedAt,
      lastCheckedAt: new Date(),
    },
  });
}

/**
 * Remove from Resend + delete the local row. We attempt Resend cleanup
 * but proceed with the local delete even if Resend errors — otherwise
 * users would get stuck unable to remove rows whose Resend counterparts
 * are missing (e.g. deleted from Resend dashboard directly).
 */
export async function removeSendingDomain(row: SendingDomain): Promise<void> {
  if (row.resendId) {
    try {
      const client = requireResend();
      await client.domains.remove(row.resendId);
    } catch (err) {
      // Best-effort — log and continue. The local row should still go.
      console.warn(`[sending-domain] Resend remove failed for ${row.id}:`, err);
    }
  }
  await prisma.sendingDomain.delete({ where: { id: row.id } });
}

/**
 * Find the agency's currently-verified domain (if any). Used by the
 * email transport to resolve the From address dynamically.
 */
export async function findVerifiedDomain(agencyId: string): Promise<SendingDomain | null> {
  return prisma.sendingDomain.findFirst({
    where:   { agencyId, status: 'verified' },
    orderBy: { verifiedAt: 'desc' },          // most-recently-verified wins (V2 multi-domain matters here)
  });
}
