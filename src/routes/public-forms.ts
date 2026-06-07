import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { writeAudit } from '../lib/audit';

/* /f/:slug/* — PUBLIC form endpoints.
   ────────────────────────────────────
   Mounted at root (NOT /v1/) so URLs are short and brandable
   (`https://app/f/khukri-newsletter`). Same convention as /u and /e.

   No auth. Submissions are anonymous. Security model:
     - Form must be active + non-archived to accept submissions
     - Honeypot field catches bots (silent success — bot doesn't know)
     - Per-IP rate limit prevents flooding (5/min in-memory)
     - Suppression list silently returns success (don't reveal status)
     - Email format validated; everything else trusted
     - All failure responses are 200 with `ok: false` (don't help
       abusers probe state)

   Endpoints:
     GET  /f/:slug/config   — form config for client-side rendering
     POST /f/:slug/submit   — process submission

   See tasks/feature-forms/change_log.md for the full design. */

export const publicFormsRouter = Router();

/* ─── Rate limiter (in-memory Map) ────────────────────────────────── */

interface RateLimitEntry {
  count:    number;
  resetAt:  number;
}

const RATE_LIMIT_MAX     = 5;             // submissions per window
const RATE_LIMIT_WINDOW  = 60_000;        // 60 seconds
const rateLimitStore = new Map<string, RateLimitEntry>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitStore.get(ip);
  if (!entry || entry.resetAt <= now) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

/* Trim stale entries periodically so the Map doesn't grow unbounded. */
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore) {
    if (entry.resetAt <= now) rateLimitStore.delete(ip);
  }
}, 5 * 60_000).unref();

function extractIp(req: import('express').Request): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim().slice(0, 45);
  }
  return req.ip?.slice(0, 45) ?? 'unknown';
}

/* ─── GET /:slug/config — form display config ─────────────────────── */

interface ConfigResponse {
  data: {
    slug:             string;
    name:             string;
    headline:         string | null;
    subheadline:      string | null;
    buttonText:       string;
    thankYouMessage:  string;
    collectFirstName: boolean;
    collectLastName:  boolean;
    brandColor:       string | null;
    requireConsent:   boolean;
    consentText:      string | null;
    agencyName:       string;
    status:           'active' | 'paused';
  } | { notFound: true };
}

publicFormsRouter.get('/:slug/config', async (req, res, next) => {
  try {
    const slug = String(req.params.slug ?? '').trim().toLowerCase();
    if (!slug) {
      return res.status(200).json({ data: { notFound: true } } as ConfigResponse);
    }

    const form = await prisma.form.findUnique({
      where: { slug },
      select: {
        slug:             true,
        name:             true,
        headline:         true,
        subheadline:      true,
        buttonText:       true,
        thankYouMessage:  true,
        collectFirstName: true,
        collectLastName:  true,
        brandColor:       true,
        requireConsent:   true,
        consentText:      true,
        status:           true,
        archived:         true,
        agency:  { select: { name: true } },
      },
    });

    if (!form || form.archived) {
      return res.status(200).json({ data: { notFound: true } } as ConfigResponse);
    }

    res.status(200).json({
      data: {
        slug:             form.slug,
        name:             form.name,
        headline:         form.headline,
        subheadline:      form.subheadline,
        buttonText:       form.buttonText,
        thankYouMessage:  form.thankYouMessage,
        collectFirstName: form.collectFirstName,
        collectLastName:  form.collectLastName,
        brandColor:       form.brandColor,
        requireConsent:   form.requireConsent,
        consentText:      form.consentText,
        agencyName:       form.agency.name,
        status:           form.status,
      },
    } as ConfigResponse);
  } catch (err) {
    next(err);
  }
});

/* ─── POST /:slug/submit — process submission ─────────────────────── */

const submitBody = z.object({
  email:      z.string().trim().toLowerCase().email({ message: 'Please enter a valid email.' }),
  first_name: z.string().trim().max(100).optional(),
  last_name:  z.string().trim().max(100).optional(),
  consent:    z.boolean().optional(),
  /* honeypot field — hidden in the rendered form; bots fill it */
  honeypot:   z.string().optional(),
}).strict();

type SubmitOk = {
  ok:               true;
  thankYouMessage:  string;
};
type SubmitFail = {
  ok:      false;
  message: string;
};
type SubmitResponse = { data: SubmitOk | SubmitFail };

publicFormsRouter.post('/:slug/submit', async (req, res) => {
  const slug = String(req.params.slug ?? '').trim().toLowerCase();
  const ip   = extractIp(req);
  const ua   = String(req.headers['user-agent'] ?? '').slice(0, 500) || null;

  /* All errors are caught + returned as 200/ok:false. Don't expose
     specifics to potential abusers. */
  try {
    /* 1. Resolve form. 404-equivalent: ok:false with neutral message
          so abusers can't probe slug existence. */
    const form = await prisma.form.findUnique({
      where: { slug },
      select: {
        id: true, agencyId: true, clientId: true, listId: true,
        status: true, archived: true, requireConsent: true,
        thankYouMessage: true,
      },
    });

    if (!form || form.archived) {
      return res.status(200).json({
        data: { ok: false, message: 'This form is no longer available.' },
      } as SubmitResponse);
    }

    if (form.status === 'paused') {
      return res.status(200).json({
        data: { ok: false, message: 'This form is no longer accepting submissions.' },
      } as SubmitResponse);
    }

    /* 2. Validate body. Email format errors surface as ok:false. */
    let body: z.infer<typeof submitBody>;
    try {
      body = submitBody.parse(req.body ?? {});
    } catch {
      return res.status(200).json({
        data: { ok: false, message: 'Please enter a valid email.' },
      } as SubmitResponse);
    }

    /* 3. Honeypot — silent success. Bot sees thank-you, no DB writes. */
    if (body.honeypot && body.honeypot.trim() !== '') {
      return res.status(200).json({
        data: { ok: true, thankYouMessage: form.thankYouMessage },
      } as SubmitResponse);
    }

    /* 4. Consent. */
    if (form.requireConsent && body.consent !== true) {
      return res.status(200).json({
        data: { ok: false, message: 'Please confirm to subscribe.' },
      } as SubmitResponse);
    }

    /* 5. Rate limit by IP. */
    if (!checkRateLimit(ip)) {
      return res.status(200).json({
        data: { ok: false, message: 'Too many submissions. Please try again in a moment.' },
      } as SubmitResponse);
    }

    /* 6. Suppression check — silent success. Don't reveal that this
          email is on the suppression list. */
    const suppressed = await prisma.suppression.findUnique({
      where:  { agencyId_email: { agencyId: form.agencyId, email: body.email } },
      select: { id: true },
    });
    if (suppressed) {
      return res.status(200).json({
        data: { ok: true, thankYouMessage: form.thankYouMessage },
      } as SubmitResponse);
    }

    /* 7-10. Upsert contact → list-contact → submission row → counter
            increment, all in one transaction. */
    const submission = await prisma.$transaction(async (tx) => {
      /* Find or create Contact. Dedup on (clientId, emailLower). */
      const existing = await tx.contact.findUnique({
        where:  { clientId_emailLower: { clientId: form.clientId, emailLower: body.email } },
        select: { id: true, firstName: true, lastName: true },
      });

      let contactId: string;
      let isNewContact: boolean;

      if (existing) {
        contactId    = existing.id;
        isNewContact = false;

        /* Backfill firstName/lastName only if the contact didn't
           already have them — don't overwrite intentional admin data. */
        const patch: { firstName?: string; lastName?: string } = {};
        if (!existing.firstName && body.first_name) patch.firstName = body.first_name;
        if (!existing.lastName  && body.last_name)  patch.lastName  = body.last_name;
        if (Object.keys(patch).length > 0) {
          await tx.contact.update({ where: { id: contactId }, data: patch });
        }
      } else {
        const created = await tx.contact.create({
          data: {
            agencyId:   form.agencyId,
            clientId:   form.clientId,
            email:      body.email,
            emailLower: body.email,                  // already lowercase from Zod
            firstName:  body.first_name ?? null,
            lastName:   body.last_name  ?? null,
            source:     'form',
          },
          select: { id: true },
        });
        contactId    = created.id;
        isNewContact = true;
      }

      /* UPSERT ListContact → status: subscribed. If they were
         'unsubscribed' before, re-subscribe (they're giving explicit
         consent again by filling out the form). */
      await tx.listContact.upsert({
        where:  { listId_contactId: { listId: form.listId, contactId } },
        create: { listId: form.listId, contactId, status: 'subscribed' },
        update: { status: 'subscribed' },
      });

      /* Insert submission audit row. */
      const sub = await tx.formSubmission.create({
        data: {
          formId:       form.id,
          contactId,
          email:        body.email,
          firstName:    body.first_name ?? null,
          lastName:     body.last_name  ?? null,
          submittedIp:  ip,
          userAgent:    ua,
          consentGiven: body.consent === true,
          isNewContact,
        },
        select: { id: true, isNewContact: true },
      });

      /* Increment denormalized counter. */
      await tx.form.update({
        where: { id: form.id },
        data:  { submissionCount: { increment: 1 } },
      });

      return sub;
    });

    /* Audit logging (outside the transaction — failure here shouldn't
       fail the submission). */
    writeAudit({
      agencyId:    form.agencyId,
      actorUserId: null,                  // public
      action:      submission.isNewContact ? 'form.new_subscriber' : 'form.resubmit',
      targetType:  'form',
      targetId:    form.id,
      metadata:    { email: body.email, listId: form.listId },
      req,
    });

    res.status(200).json({
      data: { ok: true, thankYouMessage: form.thankYouMessage },
    } as SubmitResponse);
  } catch (err) {
    console.error('[public-forms] submit error:', err);
    /* Even on internal error, return a graceful response. Better than
       leaking a stack trace to a public endpoint. */
    res.status(200).json({
      data: { ok: false, message: 'Something went wrong. Please try again.' },
    } as SubmitResponse);
  }
});
