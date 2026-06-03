/* Role-account quality check.
   ─────────────────────────────────────────────────────────────────────
   The CSV importer rejects any upload where >10% of localparts are
   "role accounts" — generic mailboxes that aren't real people
   (`info@`, `admin@`, `noreply@`, etc.). These tank deliverability
   when spammers send to them, so refusing them up-front protects the
   shared sender reputation across the platform.

   The check runs on a SAMPLE of the file (not every row) — quality is
   statistically detectable from the first ~100 rows. Sampling-by-stride
   is preferred over a head-only sample so we catch role-account
   clusters at the tail of the file too.
   ───────────────────────────────────────────────────────────────────── */

/* Common role-account localparts. Conservative — only the most generic.
   "marketing@" / "newsletter@" are intentionally NOT here (they're
   sometimes a real person's address at smaller agencies). */
export const ROLE_LOCAL_PARTS = new Set<string>([
  'info', 'admin', 'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'support', 'sales', 'contact', 'help', 'hello', 'team',
  'mail', 'email', 'office', 'enquiry', 'inquiry', 'enquiries', 'inquiries',
  'webmaster', 'postmaster', 'hostmaster', 'abuse',
  'feedback', 'service', 'customerservice', 'careers', 'jobs', 'hr',
]);

/* True if the localpart (before the @) matches one of the role keywords.
   Case-insensitive; ignores everything after a `+` (Gmail-style tags). */
export function isRoleAccount(email: string): boolean {
  const at = email.indexOf('@');
  if (at <= 0) return false;
  const local = email.slice(0, at).toLowerCase();
  const base = local.split('+')[0]!;   // strip plus-tags
  return ROLE_LOCAL_PARTS.has(base);
}

/* Fraction (0..1) of role accounts in a sample. Used to decide whether
   the whole import should be rejected. The default 10% threshold lives
   at the call site (the import route). */
export function roleAccountRate(emails: string[]): number {
  if (emails.length === 0) return 0;
  let n = 0;
  for (const e of emails) if (isRoleAccount(e)) n++;
  return n / emails.length;
}

/* Threshold above which we reject the upload. 10% per
   feature-contacts-lists §V1 scope + impl-doc §Acceptance. */
export const ROLE_ACCOUNT_REJECT_THRESHOLD = 0.10;
