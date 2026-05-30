import axios from 'axios';
import { renderHtml } from './renderForPlatform';
import type { IMjmlNode } from '../mjml/jsonToXML';

const API_BASE = 'https://api.mailerlite.com/api/v2';

interface Creds {
  apiKey: string;
  fromEmail?: string;
  fromName?: string;
}

interface Result {
  ok: boolean;
  error?: string;
  accountLabel?: string;
  url?: string;
}

const headers = (apiKey: string) => ({
  'Content-Type': 'application/json',
  'X-MailerLite-ApiKey': apiKey,
});

export async function testConnection(creds: Creds): Promise<Result> {
  if (!creds?.apiKey) return { ok: false, error: 'API key is required' };
  try {
    const { data } = await axios.get(`${API_BASE}/me`, { headers: headers(creds.apiKey), timeout: 10000 });
    return { ok: true, accountLabel: data?.account?.company || data?.email || 'MailerLite Classic account' };
  } catch (e: any) {
    const status = e?.response?.status;
    return { ok: false, error: status === 401 ? 'Invalid API key' : e?.response?.data?.error?.message ?? e?.message ?? 'Authentication failed' };
  }
}

export async function sendDraft(creds: Creds, tree: IMjmlNode, subject?: string): Promise<Result> {
  if (!creds?.apiKey) return { ok: false, error: 'API key is required' };
  if (!creds.fromEmail) return { ok: false, error: 'Set a verified From email in the integration settings.' };

  const html = renderHtml(tree, { thirdPartyClientName: 'MailerLiteClassic' });
  if (!html) return { ok: false, error: 'Template compiled to empty HTML' };

  const finalSubject = (subject ?? '').trim() || 'SendMyMail draft';
  const name = `SendMyMail draft — ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`;

  try {
    // Step 1: create the campaign shell.
    const createRes = await axios.post(
      `${API_BASE}/campaigns`,
      { type: 'regular', name, subject: finalSubject, from: creds.fromEmail, from_name: creds.fromName || creds.fromEmail },
      { headers: headers(creds.apiKey), timeout: 15000 }
    );
    const campaignId = createRes.data?.id;
    if (!campaignId) return { ok: false, error: 'MailerLite Classic returned no campaign id' };

    // Step 2: PUT the content separately (this is the v2 API shape).
    await axios.put(
      `${API_BASE}/campaigns/${campaignId}/content`,
      { html, plain: `\n\nUnsubscribe: {$unsubscribe}\nView online: {$url}`, auto_inline: false },
      { headers: headers(creds.apiKey), timeout: 15000 }
    );

    return { ok: true, url: `https://app.mailerlite.com/campaigns/${campaignId}` };
  } catch (e: any) {
    const msg = e?.response?.data?.error?.message ?? e?.response?.data?.message ?? e?.message ?? 'Send failed';
    return { ok: false, error: String(msg) };
  }
}
