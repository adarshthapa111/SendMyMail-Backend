import mjml2html from 'mjml';
import { transformSocialToRaw } from './socialToRawHtml';

export interface MjmlCompileResult {
  html: string;
  json?: unknown;
  errors: Array<{ line: number; message: string; tagName?: string }>;
}

/**
 * Wrapper around mjml2html that preprocesses social nodes into raw HTML
 * tables before MJML compilation. mjml2html runs synchronously when given a
 * JSON tree; the bundled types incorrectly mark it Promise-returning, so we
 * narrow the return type here.
 */
export const mjml2htmlProcessed = (content: any, options?: any): MjmlCompileResult => {
  transformSocialToRaw(content);
  return mjml2html(content, options) as unknown as MjmlCompileResult;
};
