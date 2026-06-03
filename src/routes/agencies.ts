import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { issueJwt } from '../lib/jwt';
import { writeAudit } from '../lib/audit';
import { requireAuth } from '../middleware/auth';
import { notFound } from '../lib/errors';
import { computeOverview } from '../lib/overview';

export const agenciesRouter = Router();

/* ─── GET /v1/agencies/overview — agency dashboard payload ──────────────── */

agenciesRouter.get('/overview', requireAuth(), async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.auth!.sub },
      select: { name: true },
    });
    if (!user) throw notFound('user_not_found');

    const payload = await computeOverview({
      agencyId: req.auth!.agency_id,
      userId:   req.auth!.sub,
      userName: user.name,
      scope:    req.auth!.scope,
    });

    res.json({ data: payload });
  } catch (err) {
    next(err);
  }
});

/* ─── POST /v1/agencies/me — workspace setup ────────────────────────────── */

const setupBody = z.object({
  name:         z.string().trim().min(1).max(100),
  country:      z.string().trim().length(2).default('NP'),       // ISO-3166 alpha-2
  billingEmail: z.string().trim().toLowerCase().email(),
});

agenciesRouter.post('/me', requireAuth({ allowUnsetupAgency: true }), async (req, res, next) => {
  try {
    const body = setupBody.parse(req.body);
    const userId = req.auth!.sub;
    const agencyId = req.auth!.agency_id;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { agency: true, clientScopes: true },
    });
    if (!user) throw notFound('user_not_found');

    const updated = await prisma.agency.update({
      where: { id: agencyId },
      data: {
        name: body.name,
        country: body.country,
        billingEmail: body.billingEmail,
        setupComplete: true,
      },
    });

    writeAudit({
      agencyId: updated.id,
      actorUserId: user.id,
      action: 'agency.setup_complete',
      metadata: { name: updated.name, country: updated.country },
      req,
    });

    const scopeIds = user.clientScopes.map((s) => s.clientId);
    const jwt = issueJwt({
      sub: user.id,
      agency_id: user.agencyId,
      role: user.role,
      scope: user.scopeType === 'all' ? { type: 'all' } : { type: 'clients', ids: scopeIds },
      email_verified: user.emailVerified,
      agency_setup: true,
    });

    res.json({
      data: {
        agency: {
          id: updated.id,
          name: updated.name,
          country: updated.country,
          billingEmail: updated.billingEmail,
          setupComplete: true,
        },
        jwt,
      },
    });
  } catch (err) {
    next(err);
  }
});
