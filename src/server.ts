import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { authRouter } from './routes/auth';
import { agenciesRouter } from './routes/agencies';
import { invitationsRouter } from './routes/invitations';
import { clientsRouter } from './routes/clients';
import { contactsRouter } from './routes/contacts';
import { contactImportsRouter } from './routes/contactImports';
import { listsRouter } from './routes/lists';
import { tagsRouter } from './routes/tags';
import { templatesRouter } from './routes/templates';
import { campaignsRouter } from './routes/campaigns';
import { onboardingRouter } from './routes/onboarding';
import { sendingDomainsRouter } from './routes/sending-domains';
import { suppressionRouter } from './routes/suppression';
import { unsubscribeRouter } from './routes/unsubscribe';
import { errorHandler, requestId } from './lib/errors';
import { jsonToHtml } from './controllers/jsonToHtml';
import { jsonToMjml } from './controllers/jsonToMjml';
import * as webhook from './controllers/integrations/webhook';
import { makePlatformController } from './controllers/integrations/factory';

import * as mailerlite from './integrations/mailerlite';
import * as mailerliteClassic from './integrations/mailerlite-classic';
import * as sendgrid from './integrations/sendgrid';
import * as postmark from './integrations/postmark';
import * as brevo from './integrations/brevo';
import * as mailjet from './integrations/mailjet';
import * as onesignal from './integrations/onesignal';
import * as airship from './integrations/airship';
import * as activecampaign from './integrations/activecampaign';
import * as stripo from './integrations/stripo';
import * as marketo from './integrations/marketo';

const app = express();
const port = Number(process.env.PORT) || 4000;
const frontendOrigin = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';

app.use(cors({ origin: frontendOrigin }));
app.use(express.json({ limit: '5mb' }));
app.use(requestId);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'sendmymail-backend' });
});

// Auth + agency setup + team management (v1 API)
app.use('/v1/auth', authRouter);
app.use('/v1/agencies', agenciesRouter);
app.use('/v1/team/invitations', invitationsRouter);
app.use('/v1/clients', clientsRouter);
// IMPORTANT: mount the imports sub-router BEFORE the contacts CRUD router —
// /contacts/imports must match before the /contacts/:id read handler grabs
// "imports" as an :id.
app.use('/v1/clients/:clientId/contacts/imports', contactImportsRouter);
app.use('/v1/clients/:clientId/contacts',         contactsRouter);
app.use('/v1/clients/:clientId/lists',            listsRouter);
app.use('/v1/clients/:clientId/tags',             tagsRouter);
app.use('/v1/clients/:clientId/templates',        templatesRouter);
app.use('/v1/clients/:clientId/campaigns',        campaignsRouter);
app.use('/v1/onboarding',                         onboardingRouter);
app.use('/v1/sending-domains',                    sendingDomainsRouter);
app.use('/v1/clients/:clientId/suppressions',     suppressionRouter);
app.use('/u',                                     unsubscribeRouter);   // public, root-mounted for short URLs

// MJML pipeline (preview / copy)
app.post('/getHtml', jsonToHtml);
app.post('/getMjml', jsonToMjml);

// Tier 4 — generic webhooks (Custom Webhook, Zapier, Make all use this)
app.post('/integrations/webhook/send', webhook.send);

// Tier 1 — every platform has the same /test + /send shape
const tier1Platforms = [
  ['mailerlite', mailerlite],
  ['mailerlite-classic', mailerliteClassic],
  ['sendgrid', sendgrid],
  ['postmark', postmark],
  ['brevo', brevo],
  ['mailjet', mailjet],
  ['onesignal', onesignal],
  ['airship', airship],
  ['activecampaign', activecampaign],
  ['stripo', stripo],
  ['marketo', marketo],
] as const;

for (const [slug, integration] of tier1Platforms) {
  const ctrl = makePlatformController(integration);
  app.post(`/integrations/${slug}/test`, ctrl.test);
  app.post(`/integrations/${slug}/send`, ctrl.send);
}

// Error handler — must be the LAST middleware. Formats any thrown ApiError /
// ZodError / unknown error into our shared { error: { code, message, ... }, request_id } shape.
app.use(errorHandler);

app.listen(port, () => {
  console.log(`sendmymail-backend listening on http://localhost:${port}`);
  console.log(`  Tier 1 wired: ${tier1Platforms.map(([s]) => s).join(', ')}`);
});
