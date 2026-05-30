import type { Request, Response } from 'express';
import { minify } from 'html-minifier-terser';
import { mjml2htmlProcessed as mjml2html } from '../mjml/mjmlWrapper';
import {
  addCustomAttributes,
  addHtmlAttributes,
  addUnsubscribeMetadataForThirdParty,
  correctTemplateScriptQuotes,
  replaceUnsubUrls,
  STANDARD_MINIFY_OPTIONS,
} from '../mjml/helpers';

const TIER_2_PLATFORMS = new Set([
  'salesforce',
  'moengagecontentblock',
  'iterablesnippet',
  'brazecontentblock',
]);

/**
 * Compiles a JSON tree into HTML.
 * Editor flow only: operationType is 'preview' or 'copy'.
 * No quota check, no export zips, no Parcel/CIO branch — those live in the
 * Figma plugin's heavier pipeline and aren't needed for the drag-and-drop editor.
 */
export const jsonToHtml = async (req: Request, res: Response) => {
  const {
    content,
    operationType,
    isHTMLMinificationEnabled,
    thirdPartyClientName,
    customProperties,
  } = req.body ?? {};

  if (!content) {
    return res.status(400).json({ error: 'Invalid request. `content` is required.' });
  }

  if (operationType !== 'preview' && operationType !== 'copy') {
    return res.status(400).json({
      error: 'Invalid operationType. Editor only supports `preview` and `copy`.',
    });
  }

  try {
    const platform = thirdPartyClientName
      ? thirdPartyClientName.toLowerCase().split('::')[0]
      : 'html';

    // 1. Swap placeholder unsub URLs with ESP-specific merge tags.
    replaceUnsubUrls(content, thirdPartyClientName);

    // 2. Compile MJML → HTML (mjml2htmlProcessed also runs transformSocialToRaw).
    const mjmlResult = mjml2html(content);
    if (mjmlResult.errors?.length) {
      // MJML returns warnings as errors — log but don't fail unless html is empty.
      console.warn('mjml warnings:', mjmlResult.errors);
    }

    // 3. Optional minification.
    let html = isHTMLMinificationEnabled
      ? await minify(mjmlResult.html, STANDARD_MINIFY_OPTIONS)
      : mjmlResult.html;

    // 4. Post-compile passes (only if HTML is non-empty).
    if (html) {
      html = addUnsubscribeMetadataForThirdParty(html, platform);
      html = correctTemplateScriptQuotes(addCustomAttributes(html, customProperties ?? {}));
      // Tier 2: ESP-specific attribute injection / wrapper stripping.
      if (TIER_2_PLATFORMS.has(platform)) {
        html = addHtmlAttributes(platform, html, customProperties ?? {});
      }
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (e: any) {
    console.error('jsonToHtml error:', e?.message);
    return res.status(400).json({
      error: 'MJML compilation failed',
      description: e?.message ?? 'unknown error',
    });
  }
};
