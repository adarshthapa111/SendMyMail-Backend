import { Resend } from 'resend';

/* Transactional email dispatch.
   ─────────────────────────────────────────────────────────────────────────
   - If RESEND_API_KEY is set → send via Resend.
   - Otherwise (or if Resend rejects) → console-log fallback (devs without
     a Resend account still get the codes / links in their backend terminal).

   FROM address:
     - When EMAIL_FROM env is set, we use it.
     - Otherwise we use Resend's onboarding sender 'onboarding@resend.dev'.
       NOTE: with Resend's free tier + unverified domain, you can only send to
       the email you signed up to Resend with. To send to any inbox, verify
       a sending domain in the Resend dashboard and set EMAIL_FROM in .env.
   ───────────────────────────────────────────────────────────────────────── */

const APP_URL = process.env.APP_URL || 'http://localhost:5173';
const FROM    = process.env.EMAIL_FROM || 'SendMyMail <onboarding@resend.dev>';
const RESEND_KEY = process.env.RESEND_API_KEY;

const resend: Resend | null = RESEND_KEY ? new Resend(RESEND_KEY) : null;

interface EmailJob {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Optional reply-to. Used by test sends so the user can hit reply and
      land back on their own inbox even though the from address is
      onboarding@resend.dev. */
  replyTo?: string;
}

function consoleStub(job: EmailJob, reason: string): void {
  console.log('\n┌─────────────────────────────────────────────────────────────');
  console.log(`│ 📧 [email ${reason}]  →  ${job.to}`);
  console.log(`│    From:    ${FROM}`);
  console.log(`│    Subject: ${job.subject}`);
  console.log(`├─────────────────────────────────────────────────────────────`);
  job.text.split('\n').forEach(line => console.log(`│ ${line}`));
  console.log('└─────────────────────────────────────────────────────────────\n');
}

/** Result shape — `messageId` is populated when Resend actually delivered
    the request to its outbound queue. On stub fallback or Resend error it
    stays undefined; callers that need a guarantee (e.g. test-send) should
    treat that as a failure and surface a toast. */
interface DispatchResult {
  messageId?: string;
}

async function dispatch(job: EmailJob): Promise<DispatchResult> {
  if (!resend) {
    consoleStub(job, 'stub — RESEND_API_KEY not set');
    return {};
  }
  try {
    const result = await resend.emails.send({
      from:    FROM,
      to:      job.to,
      subject: job.subject,
      text:    job.text,
      ...(job.html    ? { html:     job.html    } : {}),
      ...(job.replyTo ? { reply_to: job.replyTo } : {}),
    });
    if (result.error) {
      console.error('[email] Resend error:', result.error);
      consoleStub(job, `Resend failed → ${result.error.message ?? 'unknown'}`);
      return {};
    }
    console.log(`📧 [email sent via Resend] ${job.subject} → ${job.to} (id: ${result.data?.id})`);
    return { messageId: result.data?.id };
  } catch (err) {
    console.error('[email] Resend exception:', err);
    consoleStub(job, 'Resend threw — falling back');
    return {};
  }
}

/* ─── The 3 transactional emails ─────────────────────────────────────────── */

export function sendVerificationCode(opts: { to: string; name: string; code: string }) {
  return dispatch({
    to: opts.to,
    subject: `Your SendMyMail verification code: ${opts.code}`,
    text: [
      `Hi ${opts.name},`,
      '',
      `Your 6-digit verification code is: ${opts.code}`,
      '',
      'This code expires in 15 minutes. If you didn\'t request this, ignore this email.',
      '',
      '— The SendMyMail team',
    ].join('\n'),
  });
}

export function sendPasswordReset(opts: { to: string; name: string; token: string }) {
  const url = `${APP_URL}/reset/${opts.token}`;
  return dispatch({
    to: opts.to,
    subject: 'Reset your SendMyMail password',
    text: [
      `Hi ${opts.name},`,
      '',
      'Click the link below to set a new password:',
      url,
      '',
      'This link is valid for 1 hour. If you didn\'t request a reset, ignore this email — your password won\'t change.',
      '',
      '— The SendMyMail team',
    ].join('\n'),
  });
}

export function sendInvitation(opts: {
  to: string;
  inviterName: string;
  agencyName: string;
  role: string;
  token: string;
  note?: string;
}) {
  const url = `${APP_URL}/invite/${opts.token}`;
  return dispatch({
    to: opts.to,
    subject: `${opts.inviterName} invited you to join ${opts.agencyName} on SendMyMail`,
    text: [
      `Hi 👋`,
      '',
      `${opts.inviterName} invited you to join ${opts.agencyName} on SendMyMail as a ${opts.role}.`,
      '',
      opts.note ? `> "${opts.note}"\n>   — ${opts.inviterName}\n` : '',
      'Accept the invitation:',
      url,
      '',
      'This link is valid for 7 days. If you don\'t recognize this invitation, ignore this email.',
      '',
      '— The SendMyMail team',
    ].filter(Boolean).join('\n'),
  });
}

/* ─── Generic HTML send (used by template Test Send) ─────────────────────── */

/**
 * Send a pre-rendered HTML email. Used by the template builder's
 * "Send test" feature — the MJML editor's compiled HTML is shipped
 * straight to a single recipient so the user can preview the email
 * in a real inbox.
 *
 * `replyTo` is recommended: the FROM address (`onboarding@resend.dev`
 * by default) is not yours — setting `replyTo` to the user's email
 * means any "Reply" lands in their inbox.
 *
 * Returns `{ messageId }` on success, throws on failure. (The 3
 * transactional helpers above swallow failures because they're
 * fire-and-forget side effects; test send is user-initiated and
 * should surface errors.)
 */
export async function sendRawHtml(opts: {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
  /** Optional plain-text fallback. Defaults to a short note pointing the
      user at the HTML version — adequate for transactional / test sends;
      campaigns should generate proper plain-text from the MJML tree. */
  text?: string;
}): Promise<{ messageId: string }> {
  const result = await dispatch({
    to:      opts.to,
    subject: opts.subject,
    html:    opts.html,
    text:    opts.text ?? 'View this email in an HTML-capable client to see the formatted version.',
    replyTo: opts.replyTo,
  });
  if (!result.messageId) {
    throw new Error('Email send failed. Check the backend logs for the Resend error.');
  }
  return { messageId: result.messageId };
}
