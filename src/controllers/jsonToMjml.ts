import type { Request, Response } from 'express';
import { jsonToXML, type IMjmlNode } from '../mjml/jsonToXML';
import { transformSocialToRaw } from '../mjml/socialToRawHtml';
import { correctTemplateScriptQuotes, replaceUnsubUrls } from '../mjml/helpers';

/**
 * Serializes a JSON tree into an MJML string.
 * Editor flow only: operationType is 'preview' or 'copy'.
 */
export const jsonToMjml = async (req: Request, res: Response) => {
  const { content, operationType, thirdPartyClientName } = req.body ?? {};

  if (!content) {
    return res.status(400).json({ error: 'Invalid request. `content` is required.' });
  }

  if (operationType !== 'preview' && operationType !== 'copy') {
    return res.status(400).json({
      error: 'Invalid operationType. Editor only supports `preview` and `copy`.',
    });
  }

  try {
    const newContent = replaceUnsubUrls(content, thirdPartyClientName);
    transformSocialToRaw(newContent);
    const mjml = correctTemplateScriptQuotes(jsonToXML(newContent as IMjmlNode) ?? '');

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(mjml);
  } catch (e: any) {
    console.error('jsonToMjml error:', e?.message);
    return res.status(400).json({
      error: 'MJML serialization failed',
      description: e?.message ?? 'unknown error',
    });
  }
};
