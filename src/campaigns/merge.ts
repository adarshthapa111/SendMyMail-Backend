/**
 * Campaign merge-tag substitution.
 *
 * V1 whitelist: {{first_name}}, {{last_name}}, {{email}}, {{unsubscribe_url}}.
 * Other patterns pass through literally — including {{custom_field}}
 * which V2 will pick up via CampaignRecipient.mergeData jsonb.
 *
 * The send pipeline calls this for both:
 *   - the compiled HTML body (every campaign)
 *   - the subject line (V2 of feature-campaigns)
 *
 * `unsubscribe_url` is treated like the other tags but gets passed in
 * already URL-encoded — we still HTML-escape so & in query strings
 * becomes &amp; inside the body without breaking the link.
 *
 * Why a single regex with named alternation (rather than N sequential
 * replaces): same big-O but cleaner — one pass over the HTML buffer for
 * each recipient.
 */

export interface MergeValues {
  first_name?:      string;
  last_name?:       string;
  email:            string;
  unsubscribe_url?: string;
}

const MERGE_TAG_RE = /\{\{\s*(first_name|last_name|email|unsubscribe_url)\s*\}\}/g;

type MergeKey = 'first_name' | 'last_name' | 'email' | 'unsubscribe_url';

export function applyMergeTags(html: string, values: MergeValues): string {
  return html.replace(MERGE_TAG_RE, (_, key: MergeKey) => {
    return escapeHtml(values[key] ?? '');
  });
}

/**
 * Subject lines should NOT contain unsubscribe_url (would be nonsense
 * in an inbox subject), but {{first_name}}/etc. should work. Same
 * regex, narrower whitelist enforced at the caller.
 *
 * V1: caller passes the same MergeValues; we just call applyMergeTags
 * with the unsubscribe_url stripped. Cleaner than a second regex.
 */
export function applyMergeTagsSubject(subject: string, values: MergeValues): string {
  const subjectValues: MergeValues = {
    first_name: values.first_name,
    last_name:  values.last_name,
    email:      values.email,
    // intentionally NOT passing unsubscribe_url — it's not meaningful in a subject
  };
  return applyMergeTags(subject, subjectValues);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Auto-inject a small unsubscribe footer into the email HTML if the
 * template doesn't already contain {{unsubscribe_url}} OR the resolved
 * URL. Lets template authors control placement when they want to;
 * gives non-authors compliance without effort.
 *
 * Uses warm-editorial-theme colors inline (it's email HTML — CSS
 * variables don't work in most email clients). Color values match
 * theme.md tokens at the time of writing.
 */
export function injectUnsubscribeFooter(
  html: string,
  unsubUrl: string,
  agencyName: string,
): string {
  if (html.includes('{{unsubscribe_url}}') || html.includes(unsubUrl)) {
    return html;
  }
  const footer = `<table cellpadding="0" cellspacing="0" border="0" style="width:100%;margin-top:32px;border-top:1px solid #e5e2db;padding-top:16px;font-family:Arial,sans-serif;font-size:12px;color:#9c958a;text-align:center;">
  <tr><td>
    Don't want these emails? <a href="${escapeHtmlAttr(unsubUrl)}" style="color:#9c958a;text-decoration:underline;">Unsubscribe</a>
    &nbsp;·&nbsp; Sent by ${escapeHtml(agencyName)}
  </td></tr>
</table>`;

  /* Try to inject before </body>; if no </body> tag, just append. */
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${footer}\n</body>`);
  }
  return html + '\n' + footer;
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/"/g, '&quot;');
}
