import axios from 'axios';
import { renderHtml } from './renderForPlatform';
import type { IMjmlNode } from '../mjml/jsonToXML';

const API_BASE = 'https://api.onesignal.com';

interface Creds {
  apiKey: string;
  appId: string;
}

interface Result {
  ok: boolean;
  error?: string;
  accountLabel?: string;
  url?: string;
}

const headers = (apiKey: string) => ({
  Authorization: `Key ${apiKey}`,
  'Content-Type': 'application/json; charset=utf-8',
});

export async function testConnection(creds: Creds): Promise<Result> {
  if (!creds?.apiKey || !creds?.appId)
    return { ok: false, error: 'Both REST API key and App ID are required' };
  try {
    const { data } = await axios.get(`${API_BASE}/apps/${creds.appId}`, {
      headers: headers(creds.apiKey),
      timeout: 10000,
    });
    return { ok: true, accountLabel: data?.name || `OneSignal app ${creds.appId.slice(0, 8)}` };
  } catch (e: any) {
    const status = e?.response?.status;
    return {
      ok: false,
      error: status === 401 || status === 403 ? 'Invalid API key or App ID' : e?.response?.data?.errors?.[0] ?? e?.message ?? 'Authentication failed',
    };
  }
}

export async function sendDraft(creds: Creds, tree: IMjmlNode, subject?: string): Promise<Result> {
  if (!creds?.apiKey || !creds?.appId)
    return { ok: false, error: 'Both REST API key and App ID are required' };
  const html = renderHtml(tree, { thirdPartyClientName: 'OneSignal' });
  if (!html) return { ok: false, error: 'Template compiled to empty HTML' };

  const finalSubject = (subject ?? '').trim() || 'SendMyMail draft';
  const name = `SendMyMail — ${new Date().toLocaleDateString()}`;

  try {
    const { data } = await axios.post(
      `${API_BASE}/templates`,
      {
        app_id: creds.appId,
        name,
        email_subject: finalSubject,
        email_body: html,
        type: 'email',
      },
      { headers: headers(creds.apiKey), timeout: 15000 }
    );
    const id = data?.id;
    return { ok: true, url: id ? `https://dashboard.onesignal.com/apps/${creds.appId}/templates/${id}` : undefined };
  } catch (e: any) {
    const apiErrs = e?.response?.data?.errors;
    const msg = (Array.isArray(apiErrs) ? apiErrs[0] : null) ?? e?.response?.data?.message ?? e?.message ?? 'Send failed';
    return { ok: false, error: String(msg) };
  }
}
