# Feature: Database setup — change log

> Stand up PostgreSQL + Prisma in the backend, port the schema from
> `sendmymail-frontend/doc/architecture/auth-flow-and-schema.md §9` + Option B
> from `roles-and-permissions.md`, run the first migration.
>
> This is the foundation every feature PR after it depends on.

## Scope

**IN this PR:**

- Install **Prisma 6** + `@prisma/client` in `sendmymail-backend/`
- Create `prisma/schema.prisma` with 9 models (`Agency`, `User`, `OAuthIdentity`, `Client`, `UserClientScope`, `EmailVerification`, `PasswordReset`, `Invitation`, `AuditLog`) + 6 enums (`UserRole`, `ScopeType`, `AgencyPlan`, `ClientStatus`, `InvitationRole`, `OAuthProvider`)
- Wire `.env` (`DATABASE_URL` pointing at local Postgres.app on `:5434`) + add `.env.example` template
- Run the **initial migration** — creates all 9 tables + indexes + FK constraints in the local `sendmymail_dev` database
- Generate the typed Prisma Client so future Express handlers can `import { PrismaClient } from '@prisma/client'`

**NOT in this PR:**

- Auth endpoint handlers (`/v1/auth/signup`, `/login` etc.) — separate `feature-auth` PR
- Seed data / fixtures — separate `feature-database-seeds` PR when we need realistic dev data
- CHECK constraints (e.g. "Owner / Admin always `scope_type = all`") — Prisma can't declare these; will add a follow-up raw SQL migration when needed. Enforcing in app code for now.
- Hosted Postgres setup (Neon / Supabase / etc.) — defer until first deploy
- Prisma `prisma.config.ts` for Prisma 7 — chose to stay on Prisma 6.x (stable + conventional `url = env(...)` syntax)

## Acceptance criteria

- [x] `npm install` succeeds with `prisma` (dev) + `@prisma/client` (runtime)
- [x] `npx prisma migrate dev --name initial_auth_schema` exits 0
- [x] `\dt` in `psql -d sendmymail_dev` lists all 9 tables + `_prisma_migrations`
- [x] Every FK uses `ON DELETE CASCADE` (resources) or `ON DELETE SET NULL` (references like `inviter_user_id`)
- [x] All 4 user roles + 2 scope types + 4 plan/client statuses + 3 invite roles + 1 OAuth provider exist as Postgres ENUM types
- [x] `users.email` is globally `UNIQUE`
- [x] `oauth_identities` has composite unique `(provider, provider_uid)` — one Google account → one user
- [x] `user_client_scopes` is the per-client scope join table from roles-and-permissions Option B
- [x] Audit log has time-descending indexes on `(agency_id, created_at)` + `(actor_user_id, created_at)`

## Dependencies

**Added:**
- `prisma` (devDep, `^6.19`) — CLI + migration tooling
- `@prisma/client` (runtime, `^6.19`) — typed query API

## Decisions made during implementation

- **Prisma 6, not 7.** Tried Prisma 7 first; v7 introduced a breaking change requiring `prisma.config.ts` + database adapters instead of `url = env(DATABASE_URL)` in `schema.prisma`. Documentation, examples, and tooling are still mostly Prisma 5/6. Stayed on 6.19.3 (latest stable v6); v7 migration becomes a future PR if/when it pays off.
- **IDs use `cuid()` not ULID.** The docs prescribe ULID-with-prefixes (`agc_…`, `usr_…`); Prisma doesn't support that natively. `cuid()` is also sortable, URL-safe, and collision-resistant — equivalent for our needs. If we ever need the prefix-for-debugging benefit, we can switch to `@default(dbgenerated("..."))` with a custom Postgres function later.
- **Node 20 required.** Project's [doc/setup/setup.md](../../../sendmymail-frontend/doc/setup/setup.md) already prescribed Node 20/22; user was on Node 16 from a stale install. Bumped to v20.19.2 via nvm before installing Prisma (Prisma 6+ needs Node 18+).
- **`@db.Char(2)` for `Agency.country`** — ISO-3166 alpha-2 codes are always 2 chars; using fixed-width `CHAR(2)` instead of `VARCHAR`.
- **`@db.Char(6)` for `EmailVerification.code`** — 6-digit codes only, padded if needed.
- **BigInt for `AuditLog.id`** — audit volume grows fast; BigInt is one int-width forward-thinking.
- **`onDelete` rules** — `Cascade` for owned children (delete agency → delete its users/clients/audit logs); `SetNull` for soft references (inviter removed → invitation row stays, inviter id becomes null).

## Changes (newest first)

### 2026-06-01 · ✅ Done — Prisma 6 set up + initial migration applied

**What landed:**

| File | Purpose |
|---|---|
| `prisma/schema.prisma` | 9 models + 6 enums + relations + indexes |
| `prisma/migrations/20260601130508_initial_auth_schema/migration.sql` | Generated SQL for the first migration (auto-created by Prisma) |
| `.env` | `DATABASE_URL` added (alongside existing `PORT` + `FRONTEND_ORIGIN`) |
| `.env.example` | Template with `DATABASE_URL` placeholder for new contributors |
| `package.json` | `prisma` (dev) + `@prisma/client` (runtime) added |
| `node_modules/.prisma/client/` | Generated Prisma Client (typed query API) |

**Verified the dev DB has all 9 tables:**

```
public | agencies            | adarshthapa
public | audit_log           | adarshthapa
public | clients             | adarshthapa
public | email_verifications | adarshthapa
public | invitations         | adarshthapa
public | oauth_identities    | adarshthapa
public | password_resets     | adarshthapa
public | user_client_scopes  | adarshthapa
public | users               | adarshthapa
```

Plus `_prisma_migrations` (Prisma's own tracking table — keeps history of applied migrations).

**Verified the `users` table specifically:**

- Primary key `id` (text, cuid)
- Unique index on `email`
- B-tree indexes on `agency_id` + `email`
- FK to `agencies(id)` with `ON DELETE CASCADE`
- Referenced by 7 child tables with appropriate cascade rules
- `role` enum + `scope_type` enum both wired

**Connection details (local dev):**

- Host: `localhost`, port `5434` (Postgres.app v18.4)
- Database: `sendmymail_dev`
- User: `adarshthapa` (trust auth, no password)
- Connection string: `postgresql://adarshthapa@localhost:5434/sendmymail_dev?schema=public`

---

## How to use what landed in this PR

### In a TypeScript file

```ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Type-safe queries
const agency = await prisma.agency.create({
  data: {
    name: 'Nirvana Agency',
    billingEmail: 'billing@nirvana.com',
    country: 'NP',
  },
});

const user = await prisma.user.create({
  data: {
    agencyId: agency.id,
    email: 'sushant@nirvana.com',
    name: 'Sushant',
    role: 'owner',
    passwordHash: '<argon2-hash>',
    emailVerified: true,
  },
});
```

### Inspect the DB visually

```bash
npx prisma studio          # opens a GUI at localhost:5555 to browse all 9 tables
```

### After editing `schema.prisma`

```bash
npx prisma migrate dev --name <descriptive_name>
```

Generates a new migration file, applies it to dev DB, regenerates the client.

### Reset dev DB (DESTRUCTIVE — wipes all data)

```bash
npx prisma migrate reset
```

Used occasionally during dev when migrations get tangled.

### When schema is "live" and you want to deploy

```bash
npx prisma migrate deploy   # applies pending migrations without prompting
```

For prod — wire into a deploy hook later.

---

### 2026-06-01 · 📋 Planning — scope locked

Foundation PR before any auth endpoint work. ~5 new files, ~250 lines of `schema.prisma`.
