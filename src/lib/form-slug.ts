import { prisma } from './prisma';

/**
 * Form slug rules + helpers.
 *
 * Slug rules:
 *   - 3-60 chars
 *   - lowercase letters, digits, hyphens only
 *   - cannot start or end with hyphen
 *   - cannot contain consecutive hyphens
 *   - cannot match reserved words (admin, api, etc.)
 *
 * Slugs are GLOBALLY UNIQUE V1 — they live in the URL path
 * (`/f/{slug}`) without agency disambiguation. UI suggests
 * `{agency-name}-{form-name}` to make collisions rare. V2 could
 * move to subdomain routing if collision becomes a problem.
 */

/** Routes / future routes we don't let users claim. */
const RESERVED = new Set([
  // Existing public routes
  'u', 'e', 'f',
  // Existing /v1 prefixes (defensive even though slugs live under /f/)
  'api', 'v1',
  // Future-reserved
  'admin', 'app', 'www', 'mail',
  'support', 'help', 'static', 'assets', 'config', 'submit',
  'auth', 'login', 'signup', 'logout', 'forgot', 'reset',
  'settings', 'dashboard', 'home', 'about', 'pricing', 'terms', 'privacy',
  'health', 'status', 'ping',
  // Common typo destinations
  'null', 'undefined', 'true', 'false',
]);

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$/;
const MIN_LEN = 3;
const MAX_LEN = 60;

export type SlugValidation = { ok: true } | { ok: false; error: string };

export function validateSlug(s: string): SlugValidation {
  if (typeof s !== 'string')          return { ok: false, error: 'Slug must be a string.' };
  const trimmed = s.trim().toLowerCase();
  if (trimmed.length < MIN_LEN)       return { ok: false, error: `Slug must be at least ${MIN_LEN} characters.` };
  if (trimmed.length > MAX_LEN)       return { ok: false, error: `Slug must be ${MAX_LEN} characters or fewer.` };
  if (RESERVED.has(trimmed))          return { ok: false, error: 'That URL conflicts with a system route. Please choose another.' };
  if (!SLUG_PATTERN.test(trimmed))    return { ok: false, error: 'Slug must contain only lowercase letters, digits, and single hyphens. Cannot start or end with a hyphen.' };
  return { ok: true };
}

/**
 * Slugify an arbitrary string (e.g. a form name) into a candidate slug.
 * Strips accents, replaces non-alphanumerics with hyphens, collapses
 * runs of hyphens, trims hyphens at the edges. Output may still be
 * invalid (e.g. empty, too short, reserved) — caller must validate.
 */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')                    // split accented chars
    .replace(/[̀-ͯ]/g, '')      // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')          // non-alphanumeric → hyphen
    .replace(/-+/g, '-')                  // collapse hyphen runs
    .replace(/^-+|-+$/g, '')              // trim edge hyphens
    .slice(0, MAX_LEN);                   // cap length
}

/**
 * Build a default-suggested slug from an agency name + form name.
 * "Khukri Spices" + "Newsletter signup" → "khukri-spices-newsletter-signup"
 */
export function suggestSlug(agencyName: string, formName: string): string {
  const base = slugify(`${agencyName} ${formName}`);
  return base || slugify(formName) || slugify(agencyName) || 'form';
}

/**
 * Resolve a unique slug starting from a candidate. If the candidate
 * is free, returns it; otherwise appends `-2`, `-3`, … until a free
 * one is found. Caller should pre-validate format.
 *
 * Used by:
 *   - POST /forms (when user-provided slug collides)
 *   - Form duplicate (auto-suggested unique slug)
 *
 * Bounded at 50 attempts as a defensive cap — in practice the first
 * conflict-free version arrives within 1-3 tries. After 50 attempts,
 * appends a random 4-char hex suffix as last resort.
 */
export async function generateUniqueSlug(base: string): Promise<string> {
  const baseValid = validateSlug(base);
  if (!baseValid.ok) {
    throw new Error(`generateUniqueSlug called with invalid base: ${baseValid.error}`);
  }

  /* First try the base as-is. */
  const exists = await prisma.form.findUnique({ where: { slug: base }, select: { id: true } });
  if (!exists) return base;

  /* Append -2, -3, … */
  for (let n = 2; n <= 50; n++) {
    /* Truncate base if needed so the full slug stays under MAX_LEN. */
    const suffix    = `-${n}`;
    const maxBase   = MAX_LEN - suffix.length;
    const truncated = base.length > maxBase ? base.slice(0, maxBase).replace(/-+$/, '') : base;
    const candidate = `${truncated}${suffix}`;

    const collision = await prisma.form.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!collision) return candidate;
  }

  /* Fallback: random hex suffix. With 16^4 = 65,536 space and bounded
     existing slugs, collision here is astronomically unlikely. */
  const hex = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  const suffix = `-${hex}`;
  const truncated = base.slice(0, MAX_LEN - suffix.length).replace(/-+$/, '');
  return `${truncated}${suffix}`;
}
