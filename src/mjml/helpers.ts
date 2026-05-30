import * as cheerio from 'cheerio';

/**
 * Per-ESP unsubscribe merge-tag map.
 * Copied verbatim from EmailLoveBackend/src/utils/helper.ts:611
 * Editor users pick from this list in the unsubscribe-link inspector; default
 * is `html` (the literal placeholder URL that gets swapped on export).
 */
export const unsubscribeLinks: Record<string, string> = {
  html: 'https://unsubscribe.com',
  mjml: 'https://unsubscribe.com',
  mailChimp: '*|UNSUB|*',
  klaviyo: '{% unsubscribe_link %}',
  iterable: '{{unsubscribeUrl}}',
  loops: '{unsubscribe_link}',
  customer: '{% unsubscribe_url %}',
  shopify: '{unsubscribe_link}',
  stripo: '%unsubscribe-link%',
  braze: '{{${set_user_to_unsubscribed_url}}}',
  hubspot: '{{ unsubscribe_link }}',
  moengage: 'https://www.abc.com/unsubscribe',
  netcore: '[%UNSUB%]',
  dotdigital: 'https://$UNSUB$',
  blueshift: '{{unsubscribe_url}}',
  marketo: '{{system.unsubscribeLink}}',
  onesignal: '[unsubscribe_url]',
  sendx: '{{unsubscribe_url}}',
  brevo: '{{ unsubscribe }}',
  mailjet: '[[UNSUB_LINK_EN]]',
  mailerliteclassic: '{$unsubscribe}',
  mailerlite: '{$unsubscribe}',
  airship: '',
  postmark: '{{unsubscribe_url}}',
  activecampaign: '%UNSUBSCRIBELINK%',
  zeta: '{{unsubscribe_url}}',
  parcel: '{{unsubscribe_url}}',
  sendgrid: '<%asm_group_unsubscribe_raw_url%>',
};

const pickEspKey = (thirdPartyClientName?: string): string =>
  thirdPartyClientName ? thirdPartyClientName.toLowerCase().split('::')[0] : 'html';

/**
 * Walks the JSON tree's mj-text nodes and swaps the placeholder unsubscribe
 * URL with the ESP-specific merge tag. User-set merge tags are preserved
 * (this only replaces literal `https://unsubscribe.com`).
 */
export const replaceUnsubUrls = (data: any, thirdPartyClientName?: string) => {
  const espKey = pickEspKey(thirdPartyClientName);

  const traverseAndUpdate = (element: any) => {
    if (element.tagName === 'mj-text') {
      if (element.content?.includes('https://unsubscribe.com')) {
        element.content = element.content.replaceAll(
          'https://unsubscribe.com',
          unsubscribeLinks[espKey] ?? unsubscribeLinks.html
        );
      }
    } else if (element.children && element.children.length > 0) {
      element.children.forEach(traverseAndUpdate);
    }
  };

  if (Array.isArray(data)) data.forEach(traverseAndUpdate);
  else traverseAndUpdate(data);

  return data;
};

/**
 * Un-escapes XML entities inside template-script delimiters so merge tags
 * survive jsonToXML's escaping.
 *
 * %%=...=%%   AMPscript (Salesforce Marketing Cloud)
 * {{{...}}}   Triple-stash Handlebars
 * {{...}}     Handlebars/Mustache (Iterable, HubSpot, Braze, Blueshift)
 * {%...%}     Liquid/Jinja (Klaviyo, Customer.io)
 * <%...%>     ERB-style
 * [%...%]     Netcore-style
 */
export function correctTemplateScriptQuotes(templateString: string): string {
  const templateScriptPattern = /%%=.*?=%%|\{\{\{.*?\}\}\}|\{\{.*?\}\}|\{%.*?%\}|<%.*?%>|\[%.*?%\]/g;
  return templateString.replace(templateScriptPattern, (match) =>
    match
      .replace(/&quot;|&#34;|&#x22;/g, '"')
      .replace(/&#39;|&apos;|&#x27;/g, "'")
      .replace(/&lt;|&#60;|&#x3[Cc];/g, '<')
      .replace(/&gt;|&#62;|&#x3[Ee];/g, '>')
      .replace(/&amp;|&#38;|&#x26;/g, '&')
      .replace(/“|”/g, '"')
      .replace(/‘|’/g, "'")
  );
}

/**
 * Injects per-button / per-image custom HTML attributes into the compiled HTML.
 * Driven by customProperties.buttonCustom and customProperties.imageCustom
 * which are { [uuid: string]: '[{"name":"...","value":"..."}, ...]' } maps.
 */
export function addCustomAttributes(
  htmlString: string,
  properties: { buttonCustom?: Record<string, string>; imageCustom?: Record<string, string> } = {}
): string {
  let finalString = htmlString;
  if (properties.buttonCustom) finalString = addCustomAttributesButton(finalString, properties.buttonCustom);
  if (properties.imageCustom) finalString = addCustomAttributesImage(finalString, properties.imageCustom);
  return finalString;
}

function addCustomAttributesButton(htmlString: string, buttonCustom: Record<string, string>): string {
  const $ = cheerio.load(htmlString, { xml: { xmlMode: false, decodeEntities: false } });

  for (const key of Object.keys(buttonCustom)) {
    const selector = '.' + key + ' table>tbody>tr>td';
    const customAttrArray = JSON.parse(buttonCustom[key]) as Array<{ name: string; value: string }>;
    const customAttr: Record<string, string> = {};
    for (const attr of customAttrArray) customAttr[attr.name] = attr.value;
    $(selector).each((_i, element) => {
      const aElement = $(element).find('a');
      const pElement = $(element).find('p');
      if (aElement.length > 0) $(aElement).attr({ ...customAttr });
      if (pElement.length > 0) $(pElement).attr({ ...customAttr });
    });
  }
  return $.html();
}

function addCustomAttributesImage(htmlString: string, imageCustom: Record<string, string>): string {
  const $ = cheerio.load(htmlString, { xml: { xmlMode: false, decodeEntities: false } });

  for (const key of Object.keys(imageCustom)) {
    const selector = '.' + key + ' table>tbody>tr>td';
    const customAttrArray = JSON.parse(imageCustom[key]) as Array<{ name: string; value: string }>;
    const customAttr: Record<string, string> = {};
    for (const attr of customAttrArray) customAttr[attr.name] = attr.value;
    $(selector).each((_i, element) => {
      const anchorElement = $(element).find('a');
      if (anchorElement.length > 0) $(anchorElement).attr({ ...customAttr });
    });
  }
  return $.html();
}

/**
 * Post-compile pass: finds <a>unsubscribe</a> links and points them at the
 * ESP-specific URL, applies platform-specific attributes (Shopify tracking
 * token, MoEngage / Airship data attrs, Braze fuzzy match).
 */
export function addUnsubscribeMetadataForThirdParty(htmlString: string, client: string): string {
  const $ = cheerio.load(htmlString, { xml: { xmlMode: false, decodeEntities: false } });
  const unsubUrl = unsubscribeLinks[client];

  $('a').each((_i, element) => {
    if ($(element).text().toLowerCase().trim() === 'unsubscribe') {
      if (unsubUrl !== undefined) $(element).attr('href', unsubUrl);
      if (client === 'shopify') {
        $(element).text($(element).text().trim() + '{{open_tracking_block}}');
      }
      if (client === 'customer') $(element).addClass('tracked');
      if (client === 'moengage') $(element).attr('data-msys-unsubscribe', '1');
      if (client === 'airship') {
        $(element).attr('data-ua-unsubscribe', '1');
        $(element).attr('title', 'unsubscribe');
      }
    }
    if (client === 'braze') {
      if ($(element).text().toLowerCase().trim().includes('unsubscribe')) {
        $(element).attr('href', unsubUrl);
      }
    }
  });

  return $.html();
}

export const STANDARD_MINIFY_OPTIONS = {
  collapseWhitespace: true,
  removeComments: true,
  processConditionalComments: false,
  minifyCSS: false,
  maxLineLength: 500,
};

/**
 * Salesforce: tag every <a> with alias="<link text>" for SF tracking.
 */
export function addAliasAttribute(htmlString: string): string {
  const $ = cheerio.load(htmlString, { xml: { xmlMode: false, decodeEntities: false } });
  $('a').each((_i, element) => {
    const linkText = $(element).text().trim();
    if (linkText) $(element).attr('alias', linkText);
  });
  return $.html();
}

/**
 * Salesforce: tag every <a> with conversion="true".
 */
export function addConversionAttribute(htmlString: string): string {
  const $ = cheerio.load(htmlString, { xml: { xmlMode: false, decodeEntities: false } });
  $('a').each((_i, element) => {
    $(element).attr('conversion', 'true');
  });
  return $.html();
}

/**
 * Strip <head> and outermost wrapping <div> for content-block exports.
 * Used by MoEngage / Iterable snippet / Braze content block.
 */
export function removeHeadOfHtml(htmlString: string, preheader?: string): string {
  const $ = cheerio.load(htmlString);
  $('head').remove();
  if (preheader) {
    $('body > div:nth-of-type(1)').remove();
    $('body > div:first-child').replaceWith(function () {
      return $(this).contents();
    });
  } else {
    $('body > div:first-child').replaceWith(function () {
      return $(this).contents();
    });
  }
  return $('body').html() ?? '';
}

interface AddHtmlAttributesProps {
  isSalesforceAliasTrue?: boolean;
  isSalesforceConversionTrue?: boolean;
  preheader?: string;
}

/**
 * Per-platform HTML post-processing.
 * Salesforce → alias/conversion attrs on links.
 * MoEngage/Iterable snippet/Braze content block → strip head + outer wrapper.
 */
export function addHtmlAttributes(
  platform: string,
  htmlContent: string,
  customProperties: AddHtmlAttributesProps = {}
): string {
  if (platform === 'salesforce') {
    let out = htmlContent;
    if (customProperties.isSalesforceConversionTrue) out = addConversionAttribute(out);
    if (customProperties.isSalesforceAliasTrue) out = addAliasAttribute(out);
    return out;
  }
  if (
    platform === 'moengagecontentblock' ||
    platform === 'iterablesnippet' ||
    platform === 'brazecontentblock'
  ) {
    return removeHeadOfHtml(htmlContent, customProperties.preheader).trim();
  }
  return htmlContent;
}
