import { Router, type Response } from 'express';
import { prisma } from '../lib/prisma';
import { verifyOpenToken, verifyClickToken } from '../lib/tracking-token';

/* /e/o/:token + /e/c/:token — PUBLIC engagement tracking endpoints.
   ──────────────────────────────────────────────────────────────────
   Mounted at root (NOT under /v1) so the URL is short + brandable when
   it appears in email bodies (every link wrapped + a pixel injected
   means many round-trips through this router per delivered email).

   Security model:
     - Tokens are HMAC-signed with JWT_SECRET. Tampering invalidates.
     - Tokens never expire (recipients click year-old emails).
     - Open endpoint ALWAYS returns the pixel (even on invalid token)
       so email scanners don't flag the link as broken.
     - Click endpoint returns 404 on invalid token — prevents anyone
       crafting a click token that redirects to a phishing URL.

   Engagement aggregates:
     - Open: increment Send.openCount + set firstOpenedAt — ONLY on the
       first successful open per Send. Subsequent opens still create
       EmailEvent rows but don't double-count.
     - Click: increment Send.clickCount + set lastClickedAt — ONLY on the
       first click of each unique (Send, URL) pair. Subsequent clicks of
       the same URL still create EmailEvent rows but don't double-count.

   See tasks/feature-engagement-tracking/change_log.md for the full
   rationale and edge cases. */

export const trackingRouter = Router();

/* 1×1 transparent GIF (43 bytes). Smaller than a PNG; some old email
   clients render GIF more reliably. */
const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

function sendPixel(res: Response): void {
  res.set({
    'Content-Type':   'image/gif',
    'Content-Length': String(TRANSPARENT_GIF.length),
    /* no-store ensures repeat opens fire repeat requests. Without this,
       browsers / clients aggressively cache 1×1 pixels and we lose
       the per-event timeline. (Send aggregate dedupe via firstOpenedAt
       still protects the unique-open count.) */
    'Cache-Control':  'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma':         'no-cache',
    'Expires':        '0',
  });
  res.send(TRANSPARENT_GIF);
}

function extractIp(req: import('express').Request): string | null {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    /* X-Forwarded-For may be a list "client, proxy1, proxy2" — take the
       first which is the actual client. */
    return xff.split(',')[0].trim().slice(0, 45);
  }
  return req.ip?.slice(0, 45) ?? null;
}

/* ─── GET /o/:token — open tracking pixel ────────────────────────── */

trackingRouter.get('/o/:token', async (req, res) => {
  const token = String(req.params.token ?? '');
  const payload = verifyOpenToken(token);

  if (payload) {
    const ip = extractIp(req);
    const ua = String(req.headers['user-agent'] ?? '').slice(0, 500) || null;

    try {
      await prisma.$transaction([
        prisma.emailEvent.create({
          data: {
            sendId:      payload.sendId,
            type:        'open',
            recipientIp: ip,
            userAgent:   ua,
          },
        }),
        /* updateMany so that "Send doesn't exist" (was deleted) doesn't
           throw — it just matches 0 rows. firstOpenedAt: null in the
           where clause ensures we only increment on FIRST open. */
        prisma.send.updateMany({
          where: { id: payload.sendId, firstOpenedAt: null },
          data:  {
            openCount:     { increment: 1 },
            firstOpenedAt: new Date(),
          },
        }),
      ]);
    } catch (err) {
      /* Most likely cause: Send row was deleted (campaign archived).
         FK constraint on EmailEvent throws. We swallow + still return
         the pixel — the email render must never break. */
      console.warn('[tracking] open log failed:', err);
    }
  }

  /* Always return pixel — invalid tokens look the same to clients as
     valid ones. Don't reveal validity. */
  sendPixel(res);
});

/* ─── GET /c/:token — click redirect ──────────────────────────────── */

trackingRouter.get('/c/:token', async (req, res) => {
  const token = String(req.params.token ?? '');
  const payload = verifyClickToken(token);

  if (!payload) {
    /* Invalid token: 404, NOT a redirect. Prevents using us as an
       open-redirect for phishing. */
    return res.status(404).send('Link not found.');
  }

  const ip = extractIp(req);
  const ua = String(req.headers['user-agent'] ?? '').slice(0, 500) || null;

  /* Check uniqueness: has this URL been clicked on this Send before?
     Done BEFORE the insert to keep "unique clicks" accurate. */
  let isFirstClickOfUrl = false;
  try {
    const prior = await prisma.emailEvent.findFirst({
      where:  { sendId: payload.sendId, type: 'click', url: payload.url },
      select: { id: true },
    });
    isFirstClickOfUrl = !prior;

    await prisma.$transaction([
      prisma.emailEvent.create({
        data: {
          sendId:      payload.sendId,
          type:        'click',
          url:         payload.url,
          recipientIp: ip,
          userAgent:   ua,
        },
      }),
      prisma.send.updateMany({
        where: { id: payload.sendId },
        data: {
          ...(isFirstClickOfUrl ? { clickCount: { increment: 1 } } : {}),
          lastClickedAt: new Date(),
        },
      }),
      /* If recipient clicked WITHOUT loading images first, treat the
         click as also an open. updateMany guards the firstOpenedAt
         dedup the same way the open endpoint does. */
      prisma.send.updateMany({
        where: { id: payload.sendId, firstOpenedAt: null },
        data: {
          openCount:     { increment: 1 },
          firstOpenedAt: new Date(),
        },
      }),
    ]);
  } catch (err) {
    /* Logged but not user-facing — we still redirect. */
    console.warn('[tracking] click log failed:', err);
  }

  res.redirect(302, payload.url);
});
