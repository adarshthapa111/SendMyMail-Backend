/**
 * Campaign merge-tag substitution.
 *
 * V1 whitelist: {{first_name}}, {{last_name}}, {{email}}. Other patterns
 * pass through literally — including {{custom_field}} which V2 will pick
 * up via CampaignRecipient.mergeData jsonb.
 *
 * HTML-escapes the substituted value so a contact named
 * `<script>alert(1)</script>` doesn't execute when their version of the
 * email renders in Gmail (Gmail strips scripts, but defense in depth).
 *
 * Why a single regex with named alternation (rather than 3 sequential
 * replaces): same big-O but cleaner — one pass over the HTML buffer for
 * each recipient. At ~500 recipients × ~50 KB HTML = ~25 MB of work,
 * the simpler the inner loop the better.
 */

export interface MergeValues {
  first_name?: string;
  last_name?: string;
  email: string;
}

const MERGE_TAG_RE = /\{\{\s*(first_name|last_name|email)\s*\}\}/g;

export function applyMergeTags(html: string, values: MergeValues): string {
  return html.replace(MERGE_TAG_RE, (_, key: 'first_name' | 'last_name' | 'email') => {
    return escapeHtml(values[key] ?? '');
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
