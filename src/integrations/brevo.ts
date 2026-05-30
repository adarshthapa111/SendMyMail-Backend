import axios from 'axios';
import { renderHtml } from './renderForPlatform';
import type { IMjmlNode } from '../mjml/jsonToXML';

const API_BASE = 'https://api.brevo.com/v3';

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
  accept: 'application/json',
  'api-key': apiKey,
  'content-type': 'application/json',
});

export async function testConnection(creds: Creds): Promise<Result> {
  if (!creds?.apiKey) return { ok: false, error: 'API key is required' };
  try {
    const { data } = await axios.get(`${API_BASE}/account`, {
      headers: headers(creds.apiKey),
      timeout: 10000,
    });
    return { ok: true, accountLabel: data?.email || data?.companyName || 'Brevo account' };
  } catch (e: any) {
    const status = e?.response?.status;
    return {
      ok: false,
      error: status === 401 ? 'Invalid API key' : e?.response?.data?.message ?? e?.message ?? 'Authentication failed',
    };
  }
}

export async function sendDraft(creds: Creds, tree: IMjmlNode, subject?: string): Promise<Result> {
  if (!creds?.apiKey) return { ok: false, error: 'API key is required' };
  if (!creds.fromEmail) return { ok: false, error: 'Set a verified From email in the integration settings.' };

  const html = renderHtml(tree, { thirdPartyClientName: 'Brevo' });
  if (!html) return { ok: false, error: 'Template compiled to empty HTML' };

  const finalSubject = (subject ?? '').trim() || 'SendMyMail draft';
  const templateName = `SendMyMail — ${new Date().toLocaleDateString()}`;

  try {
    const { data } = await axios.post(
      `${API_BASE}/smtp/templates`,
      {
        templateName,
        subject: finalSubject,
        htmlContent: html,
        sender: { name: creds.fromName || creds.fromEmail, email: creds.fromEmail },
        isActive: true,
      },
      { headers: headers(creds.apiKey), timeout: 15000 }
    );
    const id = data?.id;
    return { ok: true, url: id ? `https://app.brevo.com/camp/template/${id}/message-setup` : undefined };
  } catch (e: any) {
    const msg = e?.response?.data?.message ?? e?.message ?? 'Send failed';
    return { ok: false, error: String(msg) };
  }
}
