import axios from 'axios';
import { renderHtml } from './renderForPlatform';
import type { IMjmlNode } from '../mjml/jsonToXML';

const REGIONS: Record<string, string> = {
  us: 'https://api.sendgrid.com',
  eu: 'https://api.eu.sendgrid.com',
};

interface Creds {
  apiKey: string;
  region?: 'us' | 'eu';
}

interface Result {
  ok: boolean;
  error?: string;
  accountLabel?: string;
  url?: string;
}

const baseUrl = (creds: Creds) => REGIONS[creds.region ?? 'us'] ?? REGIONS.us;
const headers = (creds: Creds) => ({
  Authorization: `Bearer ${creds.apiKey}`,
  'Content-Type': 'application/json',
  Accept: 'application/json',
});

export async function testConnection(creds: Creds): Promise<Result> {
  if (!creds?.apiKey) return { ok: false, error: 'API key is required' };
  try {
    const { data } = await axios.get(`${baseUrl(creds)}/v3/user/profile`, {
      headers: headers(creds),
      timeout: 10000,
    });
    return { ok: true, accountLabel: data?.email || data?.company || 'SendGrid account' };
  } catch (e: any) {
    const status = e?.response?.status;
    return {
      ok: false,
      error: status === 401 ? 'Invalid API key' : e?.response?.data?.errors?.[0]?.message ?? e?.message ?? 'Authentication failed',
    };
  }
}

export async function sendDraft(creds: Creds, tree: IMjmlNode, subject?: string): Promise<Result> {
  if (!creds?.apiKey) return { ok: false, error: 'API key is required' };
  const html = renderHtml(tree, { thirdPartyClientName: 'Sendgrid' });
  if (!html) return { ok: false, error: 'Template compiled to empty HTML' };

  const finalSubject = (subject ?? '').trim() || 'SendMyMail draft';
  const templateName = `SendMyMail — ${new Date().toLocaleDateString()}`;

  try {
    // 1. Create dynamic template
    const tpl = await axios.post(
      `${baseUrl(creds)}/v3/templates`,
      { name: templateName, generation: 'dynamic' },
      { headers: headers(creds), timeout: 15000 }
    );
    const templateId = tpl.data?.id;
    if (!templateId) return { ok: false, error: 'SendGrid returned no template id' };

    // 2. Create a version with the HTML
    await axios.post(
      `${baseUrl(creds)}/v3/templates/${templateId}/versions`,
      {
        name: templateName,
        subject: finalSubject,
        html_content: html,
        plain_content: 'Please enable HTML to view this email.',
        generate_plain_content: false,
        active: 1,
        editor: 'code',
      },
      { headers: headers(creds), timeout: 15000 }
    );

    return {
      ok: true,
      url: `https://mc.sendgrid.com/dynamic-templates/${templateId}`,
    };
  } catch (e: any) {
    const msg = e?.response?.data?.errors?.[0]?.message ?? e?.response?.data?.message ?? e?.message ?? 'Send failed';
    return { ok: false, error: String(msg) };
  }
}
