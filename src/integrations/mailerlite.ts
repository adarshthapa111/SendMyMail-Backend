import axios from 'axios';
import { renderHtml } from './renderForPlatform';
import type { IMjmlNode } from '../mjml/jsonToXML';

const API_BASE = 'https://connect.mailerlite.com/api';

interface MailerLiteCreds {
  apiKey: string;
  fromEmail?: string;
  fromName?: string;
}

export interface TestResult {
  ok: boolean;
  accountLabel?: string;
  error?: string;
}

export interface SendResult {
  ok: boolean;
  url?: string;
  error?: string;
  code?: 'plan_restricted';
}

/**
 * Verify credentials by hitting MailerLite's /me endpoint.
 */
export async function testConnection(creds: MailerLiteCreds): Promise<TestResult> {
  if (!creds?.apiKey) return { ok: false, error: 'API key is required' };
  try {
    const { data } = await axios.get(`${API_BASE}/account`, {
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        Accept: 'application/json',
      },
      timeout: 10000,
    });
    const account = data?.data ?? {};
    const label =
      account?.company_name ??
      account?.account_name ??
      account?.email ??
      'MailerLite account';
    return { ok: true, accountLabel: String(label) };
  } catch (e: any) {
    const msg =
      e?.response?.status === 401
        ? 'Invalid API key'
        : e?.response?.data?.message ?? e?.message ?? 'Authentication failed';
    return { ok: false, error: msg };
  }
}

/**
 * Create a draft campaign in MailerLite with the rendered HTML.
 * Returns the draft URL so the user can open it.
 */
export async function sendDraft(
  creds: MailerLiteCreds,
  tree: IMjmlNode,
  subjectFromUser?: string
): Promise<SendResult> {
  if (!creds?.apiKey) return { ok: false, error: 'API key is required' };
  if (!creds.fromEmail) {
    return {
      ok: false,
      error: 'Set a verified From email in the MailerLite integration settings.',
    };
  }
  const html = renderHtml(tree, { thirdPartyClientName: 'MailerLite' });
  if (!html) return { ok: false, error: 'Template compiled to empty HTML' };

  const subject = (subjectFromUser ?? '').trim() || 'SendMyMail draft';
  const name = `SendMyMail draft — ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`;

  try {
    const { data } = await axios.post(
      `${API_BASE}/campaigns`,
      {
        name,
        type: 'regular',
        emails: [
          {
            subject,
            from: creds.fromEmail,
            from_name: creds.fromName || creds.fromEmail,
            content: html, // MailerLite expects the HTML as a string, not wrapped in { html }
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${creds.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        timeout: 15000,
      }
    );
    const id = data?.data?.id;
    return {
      ok: true,
      url: id ? `https://dashboard.mailerlite.com/campaigns/${id}/overview` : undefined,
    };
  } catch (e: any) {
    const apiMsg = e?.response?.data?.message;
    const errors = e?.response?.data?.errors;
    const firstFieldErr = errors ? Object.values(errors).flat()[0] : undefined;
    let msg = String(firstFieldErr ?? apiMsg ?? e?.message ?? 'Send failed');

    // Plan-gated: MailerLite restricts API content submission to Advanced.
    if (/advanced plan/i.test(msg) || /content submission/i.test(msg)) {
      msg =
        'MailerLite only allows API content submission on the Advanced plan. ' +
        'Either upgrade your MailerLite plan, or use Export → Copy HTML and paste ' +
        'the HTML into a campaign in the MailerLite dashboard manually.';
      return { ok: false, error: msg, code: 'plan_restricted' as const };
    }

    // Make the verified-sender error actionable.
    if (/verified/i.test(msg) || /sender/i.test(msg)) {
      msg = `${msg} — go to MailerLite → Account → Domains and verify "${creds.fromEmail}", or update the From email in Integrations.`;
    }
    return { ok: false, error: msg };
  }
}
