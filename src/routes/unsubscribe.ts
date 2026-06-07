import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { verifyUnsubToken } from '../lib/unsubscribe-token';
import { writeAudit } from '../lib/audit';

/* /u/:token — PUBLIC unsubscribe endpoint.
   ─────────────────────────────────────────
   Mounted at root (NOT under /v1) so the URL is short + brandable
   when it appears in email footers ("https://app.sendmymail.io/u/abc…").

   No auth — recipients clicking from an email are anonymous. Security
   model:
     - Token is HMAC-signed with JWT_SECRET. Tampering invalidates.
     - Token contains contactId + listId + agencyId. We act on this
       trusted payload.
     - Tokens never expire (recipients click year-old emails).
     - Idempotent: clicking twice doesn't error, just shows "already
       unsubscribed".

   What this endpoint DOES:
     1. Verify HMAC.
     2. Flip ListContact.status to 'unsubscribed' for (contactId, listId)
        if both exist. Skipped if contactId or listId is empty.
     3. UPSERT into Suppression (agencyId, email = contact.email,
        reason = 'unsubscribe').
     4. Return JSON describing the result. The frontend renders the
        confirmation page from this data.

   What it returns:
     200 { ok: true,  email, agencyName }                     — success
     200 { ok: true,  email, agencyName, alreadyUnsubscribed: true } — idempotent re-click
     200 { ok: false, code: 'invalid_token' }                 — tampered or malformed
     200 { ok: false, code: 'contact_gone'  }                 — contact deleted; we add to suppression
                                                                anyway as a safety net

   Always 200 (never 404 or 4xx) so email scanners don't flag the link
   as broken. The body's `ok` field carries the actual outcome. */

export const unsubscribeRouter = Router();

unsubscribeRouter.get('/:token', async (req, res, next) => {
  try {
    const token = String(req.params.token ?? '');
    const payload = verifyUnsubToken(token);
    if (!payload) {
      return res.status(200).json({ data: { ok: false, code: 'invalid_token' } });
    }

    const { contactId, listId, agencyId } = payload;

    /* Look up the contact + agency for email + display name. */
    let email: string | null = null;
    if (contactId) {
      const contact = await prisma.contact.findFirst({
        where:  { id: contactId, agencyId, deletedAt: null },
        select: { email: true, emailLower: true },
      });
      if (contact) email = contact.email;
    }

    const agency = await prisma.agency.findUnique({
      where:  { id: agencyId },
      select: { name: true },
    });
    if (!agency) {
      /* Agency disappeared somehow — token is technically valid but
         there's no one to unsubscribe from. Treat as invalid.
         Conservatively don't write to Suppression — no agency to
         attach it to. */
      return res.status(200).json({ data: { ok: false, code: 'invalid_token' } });
    }

    /* Check if already unsubscribed (idempotent re-click). */
    let alreadyUnsubscribed = false;
    if (email) {
      const existing = await prisma.suppression.findUnique({
        where:  { agencyId_email: { agencyId, email: email.toLowerCase() } },
        select: { id: true },
      });
      if (existing) alreadyUnsubscribed = true;
    }

    /* Flip ListContact.status if both contactId + listId provided. */
    if (contactId && listId) {
      await prisma.listContact.updateMany({
        where: { contactId, listId, status: 'subscribed' },
        data:  { status: 'unsubscribed', unsubscribedAt: new Date() },
      });
    }

    /* Upsert into agency-wide suppression. If we didn't find a contact,
       we still record the unsubscribe IF we have any email at all
       (e.g. from a future webhook ingestion path). For V1: if no email,
       we can't suppress (no row created). */
    if (email && !alreadyUnsubscribed) {
      await prisma.suppression.create({
        data: {
          agencyId,
          email:  email.toLowerCase(),
          reason: 'unsubscribe',
          note:   listId ? `Unsubscribed via list ${listId}` : 'Unsubscribed via email link',
        },
      });
    }

    writeAudit({
      agencyId,
      actorUserId: null,                  // public — no user context
      action:      alreadyUnsubscribed ? 'unsubscribe.reclicked' : 'unsubscribe.confirmed',
      targetType:  'contact',
      targetId:    contactId || null,
      metadata:    { email, listId, alreadyUnsubscribed },
      req,
    });

    res.status(200).json({
      data: {
        ok:                 true,
        email:              email ?? 'this address',
        agencyName:         agency.name,
        alreadyUnsubscribed,
      },
    });
  } catch (err) {
    next(err);
  }
});
