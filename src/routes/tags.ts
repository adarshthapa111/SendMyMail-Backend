import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth, requireClientScope } from '../middleware/auth';

/* /v1/clients/:clientId/tags — read-only.
   ──────────────────────────────────────
   Tags are auto-created on first use when applied to a contact via
   POST/PATCH /v1/clients/:cid/contacts (resolveTags in contacts.ts).
   This endpoint feeds the autocomplete in the FE's ContactTagInput. */

export const tagsRouter = Router({ mergeParams: true });

tagsRouter.get('/', requireAuth(), requireClientScope, async (req, res, next) => {
  try {
    const clientId = String(req.params.clientId ?? '');
    const rows = await prisma.tag.findMany({
      where: { clientId, client: { agencyId: req.auth!.agency_id } },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, color: true, createdAt: true },
    });
    res.json({
      data: {
        items: rows.map((t) => ({
          id: t.id,
          name: t.name,
          color: t.color,
          createdAt: t.createdAt.toISOString(),
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});
