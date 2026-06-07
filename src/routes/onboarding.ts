import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { writeAudit } from '../lib/audit';

/* /v1/onboarding — feature-onboarding-wizard V1.
   ──────────────────────────────────────────────
   Guides a fresh agency to its first send. Progress is DERIVED from
   existing data (counts of clients / contacts / templates) — no new
   `onboarding_progress` table V1. Per-step timestamps for activation
   analytics can come later by adding the table the impl doc proposes.

   Endpoints:
     GET  /             — derived progress + setupComplete flag
     POST /skip         — flip Agency.setupComplete to true ("hide me")

   The impl doc proposes 4 steps (client → domain → contacts → first
   campaign). V1 ships 3 (client → contacts → template) because:
   - Domain verification is a separate PR not yet built; gating
     onboarding on it would block users.
   - "Send first campaign" requires the 6-step campaign wizard inside
     a single onboarding step — too much for an activation flow.
   - "Design template" is a meaningful checkpoint that maps to an
     existing surface (the MJML editor) and unblocks Step 4 (Pick
     template) in the campaign wizard later. */

export const onboardingRouter = Router();

/* ─── GET / — derived progress ───────────────────────────────────── */

interface ProgressResponse {
  data: {
    setupComplete: boolean;
    steps: Array<{
      id: 'client' | 'contacts' | 'template';
      title: string;
      done: boolean;
    }>;
    allDone: boolean;
  };
}

onboardingRouter.get('/', requireAuth(), async (req, res, next) => {
  try {
    const agencyId = req.auth!.agency_id;

    /* Three parallel counts; cheap (each has an indexed agency_id
       column). Could short-circuit on first non-zero but the parallel
       version is simpler and the cost is negligible. */
    const [agency, clientCount, contactCount, templateCount] = await Promise.all([
      prisma.agency.findUnique({ where: { id: agencyId }, select: { setupComplete: true } }),
      prisma.client.count({ where: { agencyId } }),
      prisma.contact.count({ where: { agencyId, deletedAt: null } }),
      prisma.template.count({ where: { agencyId, archived: false } }),
    ]);

    const steps: ProgressResponse['data']['steps'] = [
      { id: 'client',   title: 'Create your first client',  done: clientCount   > 0 },
      { id: 'contacts', title: 'Add contacts',              done: contactCount  > 0 },
      { id: 'template', title: 'Design your first template', done: templateCount > 0 },
    ];

    const allDone = steps.every((s) => s.done);

    const body: ProgressResponse = {
      data: {
        setupComplete: agency?.setupComplete ?? false,
        steps,
        allDone,
      },
    };

    res.json(body);
  } catch (err) {
    next(err);
  }
});

/* ─── POST /skip — mark onboarding skipped ────────────────────────── */

/* Flips Agency.setupComplete to true so the dashboard banner stops
   showing. Idempotent — calling on an already-complete agency is a
   no-op (still returns 200). Audit-logged because skipping is a
   meaningful action; we want to know how often users abandon
   onboarding. */
onboardingRouter.post('/skip', requireAuth(), async (req, res, next) => {
  try {
    const agencyId = req.auth!.agency_id;
    const userId   = req.auth!.sub;

    const before = await prisma.agency.findUnique({
      where:  { id: agencyId },
      select: { setupComplete: true },
    });

    if (before?.setupComplete) {
      return res.status(200).json({ data: { setupComplete: true } });
    }

    await prisma.agency.update({
      where: { id: agencyId },
      data:  { setupComplete: true },
    });

    writeAudit({
      agencyId,
      actorUserId: userId,
      action:      'onboarding.skipped',
      targetType:  'agency',
      targetId:    agencyId,
      req,
    });

    res.json({ data: { setupComplete: true } });
  } catch (err) {
    next(err);
  }
});

/* ─── POST /complete — explicitly mark complete ───────────────────── */

/* Fired by the frontend when the user clicks "Finish" on the
   onboarding page once all 3 steps are done. Distinct from /skip
   because the audit action differs (activation success vs
   abandonment), and we want to celebrate the win UX-side.

   We don't enforce server-side that all steps are actually done — the
   client validates. Worst case: a user explicitly marks complete with
   incomplete steps; their banner just stops showing. Not harmful. */
onboardingRouter.post('/complete', requireAuth(), async (req, res, next) => {
  try {
    const agencyId = req.auth!.agency_id;
    const userId   = req.auth!.sub;

    await prisma.agency.update({
      where: { id: agencyId },
      data:  { setupComplete: true },
    });

    writeAudit({
      agencyId,
      actorUserId: userId,
      action:      'onboarding.completed',
      targetType:  'agency',
      targetId:    agencyId,
      req,
    });

    res.json({ data: { setupComplete: true } });
  } catch (err) {
    next(err);
  }
});
