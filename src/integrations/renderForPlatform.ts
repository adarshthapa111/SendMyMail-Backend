import { mjml2htmlProcessed as mjml2html } from '../mjml/mjmlWrapper';
import {
  addCustomAttributes,
  addHtmlAttributes,
  addUnsubscribeMetadataForThirdParty,
  correctTemplateScriptQuotes,
  replaceUnsubUrls,
} from '../mjml/helpers';
import type { IMjmlNode } from '../mjml/jsonToXML';

export interface RenderOptions {
  thirdPartyClientName?: string;
  customProperties?: Record<string, unknown>;
}

/**
 * Run a JSON tree through the same pipeline /getHtml uses, but bypass the
 * Express request/response layer so integration controllers can call it
 * directly. Returns the final HTML string.
 *
 * Steps:
 *   1. replaceUnsubUrls       — swap placeholder unsub link with platform tag
 *   2. mjml2html              — compile MJML JSON → HTML (transformSocialToRaw inside)
 *   3. addUnsubscribeMetadata — per-ESP <a> attr rewrites
 *   4. addCustomAttributes    — inject button/image custom data attrs
 *   5. correctTemplateScriptQuotes — un-escape entities inside merge tags
 *   6. addHtmlAttributes      — Tier 2 (Salesforce / Iterable snippet / Braze content block / MoEngage block)
 */
export function renderHtml(tree: IMjmlNode, options: RenderOptions = {}): string {
  const platform = options.thirdPartyClientName
    ? options.thirdPartyClientName.toLowerCase().split('::')[0]
    : 'html';

  replaceUnsubUrls(tree, options.thirdPartyClientName);
  const compiled = mjml2html(tree);
  let html = compiled.html ?? '';
  if (!html) return '';

  html = addUnsubscribeMetadataForThirdParty(html, platform);
  html = correctTemplateScriptQuotes(addCustomAttributes(html, (options.customProperties as any) ?? {}));

  // Tier 2: Salesforce, MoEngage block, Iterable snippet, Braze content block
  if (
    platform === 'salesforce' ||
    platform === 'moengagecontentblock' ||
    platform === 'iterablesnippet' ||
    platform === 'brazecontentblock'
  ) {
    html = addHtmlAttributes(platform, html, (options.customProperties as any) ?? {});
  }

  return html;
}
