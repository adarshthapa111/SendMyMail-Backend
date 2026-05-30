import axios from 'axios';
import { jsonToXML, type IMjmlNode } from '../mjml/jsonToXML';
import { replaceUnsubUrls, correctTemplateScriptQuotes } from '../mjml/helpers';
import { transformSocialToRaw } from '../mjml/socialToRawHtml';

const API_BASE = 'https://my.stripo.email/emailgeneration/v1';

interface Creds {
  authToken: string;
  folderId?: string;
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
  'Stripo-Api-Auth': token,
});

export async function testConnection(creds: Creds): Promise<Result> {
  if (!creds?.authToken) return { ok: false, error: 'Auth token is required' };
  // Stripo doesn't expose a cheap "whoami" — best probe is the folders list.
  try {
    await axios.get(`${API_BASE}/folders`, { headers: headers(creds.authToken), timeout: 10000 });
    return { ok: true, accountLabel: 'Stripo account' };
  } catch (e: any) {
    const status = e?.response?.status;
    return {
      ok: false,
      error: status === 401 ? 'Invalid auth token' : e?.response?.data?.message ?? e?.message ?? 'Authentication failed',
    };
  }
}

export async function sendDraft(creds: Creds, tree: IMjmlNode): Promise<Result> {
  if (!creds?.authToken) return { ok: false, error: 'Auth token is required' };

  // Stripo imports MJML directly (not HTML). Run our pre-MJML pipeline only.
  replaceUnsubUrls(tree, 'Stripo');
  transformSocialToRaw(tree);
  const mjml = correctTemplateScriptQuotes(jsonToXML(tree) ?? '');
  if (!mjml) return { ok: false, error: 'Template serialized to empty MJML' };

  const templateName = `SendMyMail — ${new Date().toLocaleDateString()}`;

  try {
    const { data } = await axios.post(
      `${API_BASE}/templates/import/mjml`,
      {
        mjml,
        templateName,
        ...(creds.folderId ? { folderId: creds.folderId } : {}),
      },
      { headers: headers(creds.authToken), timeout: 20000 }
    );
    if (!data?.templateId) return { ok: false, error: 'Stripo returned no templateId' };
    return { ok: true, url: data.editorUrl || data.previewUrl };
  } catch (e: any) {
    const msg = e?.response?.data?.message ?? e?.message ?? 'Send failed';
    return { ok: false, error: String(msg) };
  }
}
