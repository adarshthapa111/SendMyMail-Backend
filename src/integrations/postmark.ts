import axios from 'axios';
import { renderHtml } from './renderForPlatform';
import type { IMjmlNode } from '../mjml/jsonToXML';

const API_BASE = 'https://api.postmarkapp.com';

interface Creds {
  serverToken: string;
}

interface Result {
  ok: boolean;
  error?: string;
  accountLabel?: string;
  url?: string;
}

const headers = (token: string) => ({
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'X-Postmark-Server-Token': token,
});

export async function testConnection(creds: Creds): Promise<Result> {
  if (!creds?.serverToken) return { ok: false, error: 'Server token is required' };
  try {
    const { data } = await axios.get(`${API_BASE}/server`, {
      headers: headers(creds.serverToken),
      timeout: 10000,
    });
    return { ok: true, accountLabel: data?.Name || 'Postmark server' };
  } catch (e: any) {
    const status = e?.response?.status;
    return {
      ok: false,
      error: status === 401 ? 'Invalid server token' : e?.response?.data?.Message ?? e?.message ?? 'Authentication failed',
    };
  }
}

export async function sendDraft(creds: Creds, tree: IMjmlNode, subject?: string): Promise<Result> {
  if (!creds?.serverToken) return { ok: false, error: 'Server token is required' };
  const html = renderHtml(tree, { thirdPartyClientName: 'Postmark' });
  if (!html) return { ok: false, error: 'Template compiled to empty HTML' };

  const finalSubject = (subject ?? '').trim() || 'SendMyMail draft';
  const name = `SendMyMail — ${new Date().toLocaleDateString()}`;

  try {
    const { data } = await axios.post(
      `${API_BASE}/templates`,
      {
        Name: name,
        Subject: finalSubject,
        HtmlBody: html,
        TextBody: 'Please enable HTML to view this email.',
      },
      { headers: headers(creds.serverToken), timeout: 15000 }
    );
    const id = data?.TemplateId;
    return { ok: true, url: id ? `https://account.postmarkapp.com/servers/templates/${id}/edit` : undefined };
  } catch (e: any) {
    const msg = e?.response?.data?.Message ?? e?.message ?? 'Send failed';
    return { ok: false, error: String(msg) };
  }
}
