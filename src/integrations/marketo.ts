import axios from 'axios';
import { renderHtml } from './renderForPlatform';
import type { IMjmlNode } from '../mjml/jsonToXML';

interface Creds {
  /** Marketo identity host, e.g. https://123-ABC-456.mktorest.com */
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /** Optional Marketo folder id to drop the template into (number). */
  folderId?: string;
}

interface Result {
  ok: boolean;
  error?: string;
  accountLabel?: string;
  url?: string;
}

const cleanUrl = (u: string) => u.replace(/\/+$/, '');

/**
 * Exchange client_credentials for an access token. Token lifespan ~1 hour;
 * we don't cache — both test and send re-request, which is fine for v1.
 */
async function getAccessToken(creds: Creds): Promise<string> {
  const { data } = await axios.get(`${cleanUrl(creds.baseUrl)}/identity/oauth/token`, {
    params: {
      grant_type: 'client_credentials',
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    },
    timeout: 10000,
  });
  if (!data?.access_token) throw new Error('No access_token returned');
  return data.access_token as string;
}

export async function testConnection(creds: Creds): Promise<Result> {
  if (!creds?.baseUrl || !creds?.clientId || !creds?.clientSecret)
    return { ok: false, error: 'Base URL, Client ID and Client Secret are required' };
  try {
    await getAccessToken(creds);
    return { ok: true, accountLabel: cleanUrl(creds.baseUrl).replace(/^https?:\/\//, '') };
  } catch (e: any) {
    const apiMsg = e?.response?.data?.error_description ?? e?.response?.data?.error;
    return { ok: false, error: String(apiMsg ?? e?.message ?? 'Authentication failed') };
  }
}

export async function sendDraft(creds: Creds, tree: IMjmlNode): Promise<Result> {
  if (!creds?.baseUrl || !creds?.clientId || !creds?.clientSecret)
    return { ok: false, error: 'Base URL, Client ID and Client Secret are required' };
  if (!creds.folderId)
    return { ok: false, error: 'Marketo requires a target Folder ID — add it in the integration settings.' };

  const html = renderHtml(tree, { thirdPartyClientName: 'Marketo' });
  if (!html) return { ok: false, error: 'Template compiled to empty HTML' };

  const accessToken = await getAccessToken(creds).catch((e: any) => {
    return { __error: String(e?.response?.data?.error_description ?? e?.message ?? 'Auth failed') } as any;
  });
  if (typeof accessToken !== 'string') return { ok: false, error: accessToken.__error };

  const uniqueId = `${new Date().toISOString().slice(0, 10).replace(/-/g, '_')}_${Math.floor(Math.random() * 1000)}`;
  const templateName = `SendMyMail_${uniqueId}`;

  // Marketo expects multipart/form-data with the HTML as a file.
  // Node 18+ has global FormData + Blob.
  const formData = new FormData();
  formData.append('name', templateName);
  formData.append('folder', JSON.stringify({ id: Number(creds.folderId), type: 'Folder' }));
  formData.append('content', new Blob([html], { type: 'text/html' }), `${templateName}.html`);

  try {
    const { data } = await axios.post(
      `${cleanUrl(creds.baseUrl)}/rest/asset/v1/emailTemplates.json`,
      formData,
      { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 20000 }
    );
    // Marketo returns HTTP 200 even on logical failure; check data.success.
    if (data?.success === false) {
      const err = data.errors?.[0];
      const code = String(err?.code ?? '');
      if (code === '601' || code === '602' || code === '603') {
        return { ok: false, error: 'Invalid API credentials (token rejected)' };
      }
      return { ok: false, error: err?.message ?? 'Marketo rejected the template upload' };
    }
    const templateId = data?.result?.[0]?.id;
    return {
      ok: true,
      url: templateId ? `${cleanUrl(creds.baseUrl).replace(/-[A-Z]+-\d+\.mktorest\.com$/, '.marketo.com')}/#ET${templateId}A1` : undefined,
    };
  } catch (e: any) {
    return { ok: false, error: e?.response?.data?.errors?.[0]?.message ?? e?.message ?? 'Send failed' };
  }
}
