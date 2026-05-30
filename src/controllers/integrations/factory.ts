import type { Request, Response } from 'express';
import type { IMjmlNode } from '../../mjml/jsonToXML';

interface Result {
  ok: boolean;
  error?: string;
  accountLabel?: string;
  url?: string;
}

interface PlatformIntegration {
  testConnection: (creds: any) => Promise<Result>;
  sendDraft: (creds: any, tree: IMjmlNode, subject?: string) => Promise<Result>;
}

/**
 * Builds {test, send} Express handlers from a platform integration module.
 * Every Tier 1 platform exposes the same shape — this factory eliminates the
 * per-platform controller boilerplate.
 */
export function makePlatformController(integration: PlatformIntegration) {
  return {
    test: async (req: Request, res: Response) => {
      const result = await integration.testConnection(req.body?.credentials ?? {});
      return res.json(result);
    },
    send: async (req: Request, res: Response) => {
      const { credentials, tree, subject } = req.body ?? {};
      if (!credentials || !tree) {
        return res.status(400).json({ ok: false, error: 'Missing credentials or tree' });
      }
      const result = await integration.sendDraft(credentials, tree, subject);
      return res.json(result);
    },
  };
}
