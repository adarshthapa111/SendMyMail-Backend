import { nanoid } from 'nanoid';

/* Slug generation for tenants (clients).
   ─────────────────────────────────────────────────────────────────────
   The slug becomes part of the URL: /clients/{slug}/campaigns etc.
   It must be ASCII-safe, kebab-case, and unique within an agency.
   Uniqueness is enforced by the DB; this module is the pure-string side.
   ───────────────────────────────────────────────────────────────────── */

const MAX_LEN = 40;

/* slugify — best-effort kebab-case from any input string.
   Returns the empty string for inputs with no ASCII alphanumerics
   (e.g. "खुकुरी मसला" or "🍔🍟"); callers should fall back to
   randomSlug() in that case. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')                  // decompose accented chars (café → cafe + combining mark)
    .replace(/[̀-ͯ]/g, '')    // strip the combining marks
    .replace(/[^a-z0-9]+/g, '-')        // collapse runs of non-ascii-alphanum into a single dash
    .replace(/^-+|-+$/g, '')            // trim leading/trailing dashes
    .slice(0, MAX_LEN);
}

/* randomSlug — fallback when slugify() returns empty.
   nanoid(6) is ~36 bits of entropy: collision probability across an
   agency's lifetime is negligible. */
export function randomSlug(): string {
  return `client-${nanoid(6).toLowerCase()}`;
}

/* slugFromName — the single function callers usually want.
   Tries slugify; falls back to a random suffix when empty. */
export function slugFromName(name: string): string {
  const s = slugify(name);
  return s.length > 0 ? s : randomSlug();
}
