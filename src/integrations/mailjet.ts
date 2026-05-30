import axios from 'axios';
import { renderHtml } from './renderForPlatform';
import type { IMjmlNode } from '../mjml/jsonToXML';

const API_BASE = 'https://api.mailjet.com/v3/REST';

interface Creds {
  publicKey: string;
  privateKey: string;
}

interface Result {
  ok: boolean;
  error?: string;
  accountLabel?: string;
  url?: string;
}

const headers = (creds: Creds) => {
  const basic = Buffer.from(`${creds.publicKey}:${creds.privateKey}`).toString('base64');
  return {
    Authorization: `Basic ${basic}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
};

export async function testConnection(creds: Creds): Promise<Result> {
  if (!creds?.publicKey || !creds?.privateKey)
    return { ok: false, error: 'Both Public and Private keys are required' };
  try {
    const { data } = await axios.get(`${API_BASE}/myprofile`, {
      headers: headers(creds),
      timeout: 10000,
    });
    const profile = data?.Data?.[0];
    return { ok: true, accountLabel: profile?.Email || profile?.CompanyName || 'Mailjet account' };
  } catch (e: any) {
    const status = e?.response?.status;
    return {
      ok: false,
      error: status === 401 ? 'Invalid keys' : e?.response?.data?.ErrorMessage ?? e?.message ?? 'Authentication failed',
    };
  }
}

export async function sendDraft(creds: Creds, tree: IMjmlNode, subject?: string): Promise<Result> {
  if (!creds?.publicKey || !creds?.privateKey)
    return { ok: false, error: 'Both Public and Private keys are required' };
  const html = renderHtml(tree, { thirdPartyClientName: 'Mailjet' });
  if (!html) return { ok: false, error: 'Template compiled to empty HTML' };

  const name = `SendMyMail — ${new Date().toLocaleDateString()}`;
  const finalSubject = (subject ?? '').trim() || 'SendMyMail draft';

  try {
    // 1. Create template
    const createRes = await axios.post(
      `${API_BASE}/template`,
      { Name: name, EditMode: 2, Purposes: ['marketing'] },
      { headers: headers(creds), timeout: 15000 }
    );
    const templateId = createRes.data?.Data?.[0]?.ID;
    if (!templateId) return { ok: false, error: 'Mailjet returned no template id' };

    // 2. PUT detail content
    await axios.post(
      `${API_BASE}/template/${templateId}/detailcontent`,
      {
        'Html-part': html,
        'Text-part': 'Please enable HTML to view this email.',
        Headers: { Subject: finalSubject },
      },
      { headers: headers(creds), timeout: 15000 }
    );

    return { ok: true, url: `https://app.mailjet.com/template/${templateId}/build` };
  } catch (e: any) {
    const msg = e?.response?.data?.ErrorMessage ?? e?.message ?? 'Send failed';
    return { ok: false, error: String(msg) };
  }
}
