import axios from 'axios';
import { renderHtml } from './renderForPlatform';
import type { IMjmlNode } from '../mjml/jsonToXML';

interface Creds {
  apiUrl: string;
  apiKey: string;
}

interface Result {
  ok: boolean;
  error?: string;
  accountLabel?: string;
  url?: string;
}

const cleanUrl = (u: string) => u.replace(/\/+$/, '');

export async function testConnection(creds: Creds): Promise<Result> {
  if (!creds?.apiUrl || !creds?.apiKey)
    return { ok: false, error: 'API URL and API key are required' };
  try {
    const { data } = await axios.get(`${cleanUrl(creds.apiUrl)}/api/3/users/me`, {
      headers: { 'Api-Token': creds.apiKey, Accept: 'application/json' },
      timeout: 10000,
    });
    return { ok: true, accountLabel: data?.user?.email || data?.user?.username || 'ActiveCampaign account' };
  } catch (e: any) {
    const status = e?.response?.status;
    return {
      ok: false,
      error: status === 401 ? 'Invalid API key' : e?.response?.data?.message ?? e?.message ?? 'Authentication failed',
    };
  }
}

export async function sendDraft(creds: Creds, tree: IMjmlNode, subject?: string): Promise<Result> {
  if (!creds?.apiUrl || !creds?.apiKey)
    return { ok: false, error: 'API URL and API key are required' };
  const html = renderHtml(tree, { thirdPartyClientName: 'ActiveCampaign' });
  if (!html) return { ok: false, error: 'Template compiled to empty HTML' };

  const finalSubject = (subject ?? '').trim() || 'SendMyMail draft';
  const fullName = `SendMyMail_${new Date().toLocaleDateString()}`;
  // Use the legacy admin/api.php endpoint — message_template_add is what works.
  const acUrl = `${cleanUrl(creds.apiUrl)}/admin/api.php?api_action=message_template_add&api_output=json`;
  const params = new URLSearchParams();
  params.append('api_output', 'json');
  params.append('name', fullName);
  params.append('html', html);
  params.append('text', 'Please enable HTML to view this email.');
  params.append('template_scope', 'all');
  params.append('subject', finalSubject);

  try {
    const { data } = await axios.post(acUrl, params.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Api-Token': creds.apiKey,
      },
      timeout: 15000,
    });
    if (data?.result_code !== 1 && data?.result_code !== '1') {
      return { ok: false, error: data?.result_message ?? 'ActiveCampaign rejected the request' };
    }
    const id = data?.id ?? data?.instanceid;
    return {
      ok: true,
      url: id ? `${cleanUrl(creds.apiUrl)}/campaigns#/templates/${id}` : undefined,
    };
  } catch (e: any) {
    const msg = e?.response?.data?.message ?? e?.message ?? 'Send failed';
    return { ok: false, error: String(msg) };
  }
}
