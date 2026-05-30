/**
 * Transforms mj-social nodes into mj-raw nodes containing a single HTML table.
 *
 * Horizontal mode: all icons in one row (<td> per icon)
 * Vertical mode: each icon in its own row
 *
 * No MSO conditionals or display:inline-table hacks — a single table
 * renders natively in all email clients including Outlook.
 *
 * CSS class placement:
 *   - Social container class (mj-so) on outer <td>
 *   - Element class (mj-se) on each icon <td> directly
 *   - Image is a direct child of <td> (or <td> > <a> > <img>)
 */

interface SocialElementAttributes {
  src?: string;
  href?: string;
  alt?: string;
  'icon-size'?: string;
  'icon-height'?: string;
  'border-radius'?: string;
  'css-class'?: string;
  padding?: string;
  'padding-top'?: string;
  'padding-right'?: string;
  'padding-bottom'?: string;
  'padding-left'?: string;
  'icon-padding'?: string;
  [key: string]: any;
}

/**
 * Parses icon-padding shorthand (e.g. "0px 3px 0px 3px") into individual values.
 * Falls back to individual padding-* attributes, then to '0px'.
 */
const parseIconPadding = (attrs: SocialElementAttributes): { top: string; right: string; bottom: string; left: string } => {
  if (attrs['icon-padding']) {
    const parts = attrs['icon-padding'].replace(/px/g, '').trim().split(/\s+/);
    if (parts.length === 4) {
      return { top: parts[0] + 'px', right: parts[1] + 'px', bottom: parts[2] + 'px', left: parts[3] + 'px' };
    }
    if (parts.length === 1) {
      const val = parts[0] + 'px';
      return { top: val, right: val, bottom: val, left: val };
    }
    if (parts.length === 2) {
      return { top: parts[0] + 'px', right: parts[1] + 'px', bottom: parts[0] + 'px', left: parts[1] + 'px' };
    }
    if (parts.length === 3) {
      return { top: parts[0] + 'px', right: parts[1] + 'px', bottom: parts[2] + 'px', left: parts[1] + 'px' };
    }
  }

  return {
    top: attrs['padding-top'] || '0px',
    right: attrs['padding-right'] || '0px',
    bottom: attrs['padding-bottom'] || '0px',
    left: attrs['padding-left'] || '0px',
  };
};

const parsePixelValue = (val: string | undefined, fallback: number = 0): number => {
  if (!val) return fallback;
  const num = parseFloat(val.replace('px', ''));
  return isNaN(num) ? fallback : num;
};

const escapeHtmlAttr = (val: string): string => {
  return val.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
};

const buildContainerPadding = (attrs: any): string => {
  const pt = attrs['padding-top'];
  const pr = attrs['padding-right'];
  const pb = attrs['padding-bottom'];
  const pl = attrs['padding-left'];

  if (pt !== undefined || pr !== undefined || pb !== undefined || pl !== undefined) {
    return `${pt || '0px'} ${pr || '0px'} ${pb || '0px'} ${pl || '0px'}`;
  }
  return attrs.padding || '0px';
};

/**
 * Builds a single <td> for one social element icon.
 * The CSS class goes directly on the <td> so mobile styles can target it as `.nodeClass`.
 */
const buildSocialElementTd = (element: any, socialBorderRadius: string): string => {
  const attrs: SocialElementAttributes = element.attributes || {};

  const iconSize = parsePixelValue(attrs['icon-size'], 24);
  const iconHeight = parsePixelValue(attrs['icon-height'], iconSize);
  const borderRadius = attrs['border-radius'] || socialBorderRadius || '0px';
  const cssClass = attrs['css-class'] || '';
  const src = attrs.src || '';
  const href = attrs.href || '';
  const alt = attrs.alt || '';

  // Icon padding (from icon-padding shorthand or individual padding-* attributes)
  const iconPad = parseIconPadding(attrs);
  const iconPadding = `${iconPad.top} ${iconPad.right} ${iconPad.bottom} ${iconPad.left}`;

  // Build image tag
  const imgTag = `<img alt="${escapeHtmlAttr(alt)}" height="${iconHeight}" src="${escapeHtmlAttr(src)}" style="border-radius:${borderRadius};display:block;width:${iconSize}px;height:${iconHeight}px;" width="${iconSize}" />`;

  // Wrap in anchor if href is provided
  const imageContent = href
    ? `<a href="${escapeHtmlAttr(href)}" target="_blank">${imgTag}</a>`
    : imgTag;

  return `<td class="${escapeHtmlAttr(cssClass)}" style="padding:${iconPadding};vertical-align:middle;font-size:0;">${imageContent}</td>`;
};

/**
 * Converts each child of mj-social into an HTML fragment:
 *   - mj-social-element → <td> cell
 *   - mj-raw → raw content (e.g. MSO conditionals for dark mode logo variants)
 */
const buildChildHtml = (child: any, socialBorderRadius: string): { type: 'td' | 'raw'; html: string } => {
  if (child.tagName === 'mj-social-element') {
    return { type: 'td', html: buildSocialElementTd(child, socialBorderRadius) };
  }
  if (child.tagName === 'mj-raw') {
    return { type: 'raw', html: child.content || '' };
  }
  return { type: 'raw', html: '' };
};

/**
 * Builds the complete social bar HTML as a single table.
 * Horizontal: one <tr> with multiple <td> cells.
 * Vertical: multiple <tr> rows, each with one <td>.
 *
 * Dark mode logo variants produce interleaved mj-raw children
 * (MSO conditional comments) between light/dark social elements.
 * These are output inline within the table row(s).
 */
const buildSocialHtml = (node: any): string => {
  const attrs = node.attributes || {};
  const children: any[] = (node.children || []);

  const align = attrs.align || 'center';
  const bgColor = attrs['container-background-color'] || 'transparent';
  const cssClass = attrs['css-class'] || '';
  const borderRadius = attrs['border-radius'] || '0px';
  const isVertical = attrs.mode === 'vertical';
  const containerPadding = buildContainerPadding(attrs);

  const fragments = children.map((child) => buildChildHtml(child, borderRadius));

  let rowsHtml: string;
  if (isVertical) {
    // Each icon in its own row; raw fragments (dark mode conditionals) placed between rows
    rowsHtml = fragments
      .map((f) => f.type === 'td' ? `<tr>${f.html}</tr>` : f.html)
      .join('\n');
  } else {
    // All fragments in a single row; raw fragments sit between <td> cells
    rowsHtml = `<tr>${fragments.map((f) => f.html).join('')}</tr>`;
  }

  return `<tr>
<td align="${align}" class="${escapeHtmlAttr(cssClass)}" style="background:${bgColor};font-size:0px;padding:${containerPadding};word-break:break-word;">
<table border="0" cellpadding="0" cellspacing="0" role="presentation">
${rowsHtml}
</table>
</td>
</tr>`;
};

/**
 * Recursively walks the JSON node tree and replaces mj-social nodes
 * with mj-raw nodes containing the equivalent raw HTML table.
 * Mutates the tree in-place.
 */
export const transformSocialToRaw = (node: any): void => {
  if (!node || typeof node !== 'object') return;

  if (Array.isArray(node.children)) {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      if (child?.tagName === 'mj-social') {
        const rawHtml = buildSocialHtml(child);
        node.children[i] = {
          tagName: 'mj-raw',
          attributes: {},
          content: rawHtml,
          children: [],
        };
      } else {
        transformSocialToRaw(child);
      }
    }
  }
};
