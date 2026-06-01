/* Transactional email dispatch — V1 stub.
   In dev: logs to console (so you can grab verification codes / reset URLs / invite URLs from the backend terminal).
   In prod: TODO — wire up SendGrid / Resend / our own MJML pipeline.
   The signatures below stay the same when the real transport lands. */

const APP_URL = process.env.APP_URL || 'http://localhost:5173';
const FROM = 'SendMyMail <noreply@sendmymail.io>';

interface EmailJob {
  to: string;
  subject: string;
  text: string;
  // html?: string;  — real transport will add this
}

async function dispatch(job: EmailJob): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    // TODO: real transport
    throw new Error('Email transport not yet wired for production');
  }
  // Dev: dump to console so the developer can grab codes / links.
  console.log('\n┌─────────────────────────────────────────────────────────────');
  console.log(`│ 📧 [email stub]  →  ${job.to}`);
  console.log(`│    From:    ${FROM}`);
  console.log(`│    Subject: ${job.subject}`);
  console.log(`├─────────────────────────────────────────────────────────────`);
  job.text.split('\n').forEach(line => console.log(`│ ${line}`));
  console.log('└─────────────────────────────────────────────────────────────\n');
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
