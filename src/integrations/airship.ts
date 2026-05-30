import axios from 'axios';
import { renderHtml } from './renderForPlatform';
import type { IMjmlNode } from '../mjml/jsonToXML';

interface Creds {
  appKey: string;
  bearerToken: string;
  region?: 'us' | 'eu';
  fromEmail?: string;
  fromName?: string;
}

interface Result {
  ok: boolean;
  error?: string;
  accountLabel?: string;
  url?: string;
}

const baseUrl = (region?: string) => (region === 'eu' ? 'https://go.airship.eu' : 'https://go.urbanairship.com');

const headers = (creds: Creds) => {
  const basic = Buffer.from(`${creds.appKey}:${creds.bearerToken}`).toString('base64');
  return {
    Authorization: `Basic ${basic}`,
    Accept: 'application/vnd.urbanairship+json; version=3',
    'Content-Type': 'application/json',
  };
};

export async function testConnection(creds: Creds): Promise<Result> {
  if (!creds?.appKey || !creds?.bearerToken)
    return { ok: false, error: 'App key and Bearer token are required' };
  try {
    // Simple identity probe — listing devices is gated; templates list is a cheap probe.
    await axios.get(`${baseUrl(creds.region)}/api/templates`, {
      headers: headers(creds),
      timeout: 10000,
    });
    return { ok: true, accountLabel: `Airship app ${creds.appKey.slice(0, 8)}` };
  } catch (e: any) {
    const status = e?.response?.status;
    return {
      ok: false,
      error: status === 401 ? 'Invalid app key or bearer token' : e?.response?.data?.error ?? e?.message ?? 'Authentication failed',
    };
  }
}

export async function sendDraft(creds: Creds, tree: IMjmlNode, subject?: string): Promise<Result> {
  if (!creds?.appKey || !creds?.bearerToken)
    return { ok: false, error: 'App key and Bearer token are required' };
  const html = renderHtml(tree, { thirdPartyClientName: 'Airship' });
  if (!html) return { ok: false, error: 'Template compiled to empty HTML' };

  const finalSubject = (subject ?? '').trim() || 'SendMyMail draft';
  const name = `SendMyMail — ${new Date().toLocaleDateString()}`;

  try {
    const { data } = await axios.post(
      `${baseUrl(creds.region)}/api/templates`,
      {
        name,
        variants: [
          {
            push: {
              notification: {
                email: {
                  subject: finalSubject,
                  html_body: html,
                  plaintext_body: 'Please enable HTML to view this email.',
                  message_type: 'commercial',
                  sender_name: creds.fromName || 'SendMyMail',
                  sender_address: creds.fromEmail || 'noreply@example.com',
                  reply_to: creds.fromEmail || 'noreply@example.com',
                },
              },
            },
          },
        ],
      },
      { headers: headers(creds), timeout: 15000 }
    );
    const id = data?.template_id;
    return { ok: true, url: id ? `https://go.airship.com/accounts/applications/${creds.appKey}/templates/${id}` : undefined };
  } catch (e: any) {
    const msg = e?.response?.data?.error ?? e?.response?.data?.details?.error ?? e?.message ?? 'Send failed';
    return { ok: false, error: String(msg) };
  }
}
