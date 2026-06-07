import { signOpenToken, signClickToken } from '../lib/tracking-token';

/**
 * HTML rewriter for engagement tracking.
 *
 * Two transformations applied to outgoing campaign HTML:
 *
 * 1. Wrap every `<a href="X">` so the URL routes through /e/c/{token}
 *    where the token signs (sendId, originalUrl).
 *
 * 2. Inject a 1×1 transparent tracking pixel before `</body>` (or at
 *    the very end if there's no body tag), with a signed open token.
 *
 * Skipped href schemes (don't wrap):
 *   - mailto:        → recipient's mail client should open the address
 *   - tel:           → phone dialer
 *   - #fragment      → in-email jump links (rare in email)
 *   - javascript:    → would be stripped by Gmail anyway; don't touch
 *   - data:          → inline data URLs
 *   - Already-rewritten links (contain /e/c/ or /e/o/ to our domain)
 *
 * Idempotency: calling this twice on the same HTML doesn't double-wrap
 * (we detect already-rewritten links via APP_URL substring).
 *
 * URL preservation: query strings, fragments, and unicode survive the
 * round-trip — we sign the verbatim string and the click endpoint
 * 302-redirects to the original bytes.
 */

const APP_URL = process.env.APP_URL || 'http://localhost:5173';

const SKIP_HREF = /^(mailto:|tel:|#|javascript:|data:)/i;

/* HTML attribute decoding — emails commonly contain
   href="https://example.com/?a=1&amp;b=2". We need the DECODED URL
   for signing (so when we 302 back to it, the recipient lands at
   the URL the template author wrote). When we re-emit the wrapped
   href, no further encoding is needed because the token is base64url
   (no special chars).

   We only handle the common entities; obscure ones (numeric refs etc.)
   would round-trip incorrectly but are rare in real-world email HTML. */
function decodeHtmlAttr(s: string): string {
  return s
    .replace(/&amp;/g,  '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>');
}

/**
 * Returns the input HTML with all eligible <a href> rewritten and a
 * tracking pixel appended. No-op if html is empty.
 */
export function injectTracking(html: string, sendId: string): string {
  if (!html) return html;

  /* Phase 1 — link wrapping.
     Single pass with a non-greedy attribute match. Match `href="..."` or
     `href='...'`. We don't currently support unquoted href values (very
     rare in MJML output). */
  const rewritten = html.replace(
    /href\s*=\s*(["'])([^"']+)\1/gi,
    (match, quote: string, rawUrl: string) => {
      const decoded = decodeHtmlAttr(rawUrl);
      if (SKIP_HREF.test(decoded)) return match;
      /* Skip already-rewritten or self-referencing links */
      if (decoded.startsWith(`${APP_URL}/e/c/`)) return match;
      if (decoded.startsWith(`${APP_URL}/e/o/`)) return match;

      const token = signClickToken(sendId, decoded);
      return `href=${quote}${APP_URL}/e/c/${token}${quote}`;
    },
  );

  /* Phase 2 — pixel injection.
     Skip if a tracking pixel already exists pointing at our domain
     (idempotent). */
  if (rewritten.includes(`${APP_URL}/e/o/`)) return rewritten;

  const openToken = signOpenToken(sendId);
  /* The pixel:
       - width/height 1: actual tracker
       - alt="": ignored by screen readers / image-off displays
       - inline styles: hide more aggressively; some clients still render
         alt text otherwise
       - border/outline 0: belt-and-suspenders for old Outlook
       - display:block: prevents some clients adding spacing */
  const pixel = `<img src="${APP_URL}/e/o/${openToken}" alt="" width="1" height="1" style="display:block;border:0;outline:none;text-decoration:none;height:1px;width:1px;" />`;

  if (/<\/body>/i.test(rewritten)) {
    return rewritten.replace(/<\/body>/i, `${pixel}\n</body>`);
  }
  return rewritten + '\n' + pixel;
}
