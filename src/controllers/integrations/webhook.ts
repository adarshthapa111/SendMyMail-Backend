import type { Request, Response } from 'express';
import axios from 'axios';
import { renderHtml } from '../../integrations/renderForPlatform';

/**
 * POST the compiled HTML to a user-supplied URL.
 * Used by Custom Webhook, Zapier, and Make — all three share this endpoint.
 *
 * Request body:
 *   { credentials: { url }, tree, thirdPartyClientName }
 * Response:
 *   { ok: true } or { ok: false, error }
 */
export const send = async (req: Request, res: Response) => {
  const { credentials, tree, thirdPartyClientName, subject } = req.body ?? {};
  const url: string | undefined = credentials?.url;

  if (!url || !tree) {
    return res.status(400).json({ ok: false, error: 'Missing url or tree' });
  }
  if (!/^https?:\/\/.+/i.test(url)) {
    return res.status(400).json({ ok: false, error: 'Invalid URL' });
  }

  try {
    const html = renderHtml(tree, { thirdPartyClientName });
    await axios.post(
      url,
      {
        html,
        subject: (subject ?? '').trim() || undefined,
        source: thirdPartyClientName ?? 'sendmymail',
      },
      {
        timeout: 10000,
        headers: { 'Content-Type': 'application/json' },
        // Don't throw on non-2xx — webhooks often return 200 with body details.
        validateStatus: () => true,
      }
    );
    return res.json({ ok: true });
  } catch (e: any) {
    const msg = e?.code === 'ECONNABORTED'
      ? 'Webhook timed out after 10s'
      : e?.message ?? 'Webhook send failed';
    return res.json({ ok: false, error: msg });
  }
};
