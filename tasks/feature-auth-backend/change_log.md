# Feature: Auth backend — change log

> Build the Express endpoints that implement
> [auth-flow-and-schema.md](../../../sendmymail-frontend/doc/architecture/auth-flow-and-schema.md)
> + [invite-flow.md](../../../sendmymail-frontend/doc/architecture/invite-flow.md)
> on top of the Prisma schema set up in `feature-database-setup`.
>
> Split into 6 sub-PRs so each lands as a self-contained, testable chunk. Foundation
> sub-PR 1 has zero endpoints; each subsequent sub-PR adds 1–4 endpoints + tests via
> curl + audit log writes + email dispatch (dev: console; prod: deferred).

## Scope (parent feature) — 2 PRs

**PR 1 — Auth Core** (this PR — the email/password happy path, ~80% of users):

| What | Endpoints |
|---|---|
| Foundation | argon2 / JWT / token / email-stub libs; auth + role + scope middleware; rate-limit middleware; error shape; Prisma singleton |
| Signup + verify | `POST /v1/auth/signup`, `POST /v1/auth/verify`, `GET /v1/auth/me` |
| Login + password recovery | `POST /v1/auth/login`, `POST /v1/auth/logout`, `POST /v1/auth/forgot`, `POST /v1/auth/reset/:token` |
| Workspace setup | `POST /v1/agencies/me` |

**Total PR 1: 8 endpoints.** After this PR a user can: sign up → verify their email → set up their agency → log in → reset password if forgotten. That's the canonical happy path.

**PR 2 — Auth Extensions** (next PR — Google sign-in + invites):

| What | Endpoints |
|---|---|
| Google OAuth | `GET /v1/auth/google/start`, `GET /v1/auth/google/callback` |
| Invitations | `POST /v1/team/invitations`, `PATCH /v1/team/invitations/:id`, `POST /v1/team/invitations/:id/resend`, `POST /v1/team/invitations/:id/revoke`, `GET /v1/team/invitations`, `GET /v1/auth/invitations/:token`, `POST /v1/auth/invitations/:token/accept` |

**Total PR 2: 9 endpoints.** Adds the alternative paths — Google sign-in + invited team members + viewer-scoped client logins.

**NOT in this feature (separate PRs):**
- Frontend auth pages — `tasks/feature-auth-frontend/`
- Real auth slice + router guard wiring — `tasks/feature-auth-frontend/`
- Real email transport (SendGrid/Resend/SES) — `tasks/feature-email-transport/`. **Dev uses a console-logging stub.**
- 2FA / TOTP — deferred to post-V1 per [auth-flow-and-schema.md §11](../../../sendmymail-frontend/doc/architecture/auth-flow-and-schema.md)
- JWT revocation table — deferred

## Acceptance criteria (parent feature)

After all 6 sub-PRs:

- [ ] `POST /v1/auth/signup` → creates Owner + agency, sends 6-digit code via email stub, returns JWT with `email_verified=false`
- [ ] `POST /v1/auth/verify { code }` → marks `email_verified=true`, reissues JWT
- [ ] `POST /v1/agencies/me { name, country, billing_email }` → marks `setup_complete=true`, reissues JWT
- [ ] `POST /v1/auth/login { email, password }` → returns JWT (or `401` + brute-force counter)
- [ ] `POST /v1/auth/forgot { email }` → silently `200`, sends reset email if user exists
- [ ] `POST /v1/auth/reset/:token { new_password }` → updates password if token valid + unused + unexpired
- [ ] `GET /v1/auth/google/start` → 302 to Google with `state` nonce
- [ ] `GET /v1/auth/google/callback?code=...` → either signs in, links, or creates new agency owner per the §3 decision tree
- [ ] `POST /v1/team/invitations { email, role, scope }` → creates pending invitation row, sends invite email
- [ ] `POST /v1/auth/invitations/:token/accept { name, password? }` → creates new user under inviting agency with locked-at-invite-time role/scope
- [ ] Every endpoint rate-limited (signup 5/hr/IP, login 5 attempts then 15-min lockout, resend 1/5min per invite)
- [ ] Every auth action writes to `audit_log` with actor, target, IP, user-agent
- [ ] Errors follow the [api-conventions.md §4](../../../sendmymail-frontend/doc/architecture/api-conventions.md) shape: `{ error: { code, message, field?, details? }, request_id }`
- [ ] JWT shape matches [auth-flow-and-schema.md §6](../../../sendmymail-frontend/doc/architecture/auth-flow-and-schema.md#7-the-jwt--whats-in-it-how-long-it-lives): `sub` / `agency_id` / `role` / `scope` / `email_verified` / `agency_setup` / `iat` / `exp` / `jti`
- [ ] All endpoints documented with curl examples in the change_log

## Dependencies

**To add in sub-PR 1:**

| Package | Purpose |
|---|---|
| `argon2` | Password hashing (memory_cost=64MB, time_cost=3, parallelism=1) |
| `jsonwebtoken` + `@types/jsonwebtoken` | JWT issue + verify |
| `zod` | Request body validation |
| `nanoid` | URL-safe random tokens for reset/invite |
| `express-rate-limit` | Brute-force protection |
| `google-auth-library` *(sub-PR 5)* | Verifying Google ID tokens via Google's public keys |

## Cross-cutting decisions

- **Token storage:** raw tokens (reset, invite) only live in URLs. The DB stores **only the SHA-256 hash** of the URL token. Verification = hash the incoming token, look it up.
- **JWT issuance points:** on every signup, verify, workspace-setup, login, role-change, scope-change. Server returns a fresh JWT in either the response body OR `X-Refreshed-Token` header; client swaps it into `localStorage['sendmymail_jwt']`.
- **`jti` claim** carried on every JWT — preps for a future revocation table.
- **Email transport:** dev is a console-logging stub (`console.log('[email]', { to, subject, body })`). Real transport (SendGrid / Resend / SES) is a separate `feature-email-transport` PR. The auth flow still works end-to-end in dev because the codes are visible in the backend logs.
- **Rate limit storage:** in-memory (`express-rate-limit` default) for V1. Acceptable since we have a single backend instance. When we scale horizontally, swap to Redis-backed limiter.
- **Generic error messages** for auth failures: "invalid credentials" instead of "wrong password" vs "no such user" — prevents email enumeration.
- **`/forgot` always returns 200** — prevents email enumeration on the reset path too.
- **Password requirements (V1):** ≥8 chars, ≥1 number, ≥1 symbol. Validated server-side via zod regex.

## Changes (newest first)

### 2026-06-01 · ✅ Done — PR 1 (Auth Core) shipped + smoke-tested

**What landed: 8 endpoints, 12 new source files, full happy-path verified with curl.**

| Layer | Files |
|---|---|
| Foundation libs | `src/lib/prisma.ts` (singleton + graceful shutdown) · `jwt.ts` (HS256 + 7-day TTL + `jti`) · `passwords.ts` (argon2id + strength check) · `tokens.ts` (32-byte url-safe + sha256 + 6-digit code) · `email.ts` (dev console stub) · `errors.ts` (`ApiError` + `errorHandler` + `requestId`) · `audit.ts` (fire-and-forget audit writes) |
| Middleware | `src/middleware/auth.ts` (`requireAuth` / `requireRole` / `requireClientScope`) · `rateLimit.ts` (signup / login / forgot / verify / resend limiters) |
| Routes | `src/routes/auth.ts` · `src/routes/agencies.ts` |
| Types | `src/types/express.d.ts` (extends `Request` with `req.auth` + `req.request_id`) |
| Wiring | `src/server.ts` mounts `/v1/auth` + `/v1/agencies`, adds `requestId` + `errorHandler` |
| Env | `.env`: `APP_URL`, `NODE_ENV`, `JWT_SECRET`. `.env.example` updated. |

**Endpoints, all verified working:**

| Method | Path | Outcome |
|---|---|---|
| POST | `/v1/auth/signup` | 201 — Owner + new agency created, JWT issued, verification code emailed |
| POST | `/v1/auth/verify` | 200 — `email_verified=true`, JWT reissued |
| GET | `/v1/auth/me` | 200 — user + agency snapshot |
| POST | `/v1/auth/login` | 200 — JWT issued · 401 on bad creds (generic msg) · 5 failures → 15-min lockout |
| POST | `/v1/auth/logout` | 204 — audit row written |
| POST | `/v1/auth/forgot` | 200 always — silent (anti-enumeration), reset email sent if user exists |
| POST | `/v1/auth/reset/:token` | 200 — looks up by SHA-256 hash, updates password atomically |
| POST | `/v1/agencies/me` | 200 — `setup_complete=true`, JWT reissued |

**Decisions worth knowing:**

- **`localhost` → `127.0.0.1` in DATABASE_URL.** Node 20 resolves `localhost` to IPv6 `::1` first; Prisma's Postgres driver wouldn't connect via IPv6 even though Postgres.app listens on both. Forcing IPv4 fixed it. Future contributors take note.
- **Constant-time-ish login.** Even when the email doesn't exist, we run an argon2 verify against a fake hash so timing attacks can't enumerate emails through `/login`.
- **`/forgot` always returns `{ ok: true }`** — never reveals whether the email exists. Same anti-enumeration pattern.
- **Failed-login counter** on `users.failed_login_count` + `users.locked_until`. 5 failures → 15-min lockout. Reset on successful login.
- **Stateless JWT logout** — client just discards the token. Revocation table is deferred (`jti` already in place for when we add it).
- **Email is a console stub.** Codes / reset URLs / invite URLs print to the backend terminal. Real transport lands in a future `feature-email-transport` PR.
- **Workspace setup is `POST /v1/agencies/me`** (not PATCH) — matches auth-flow §2 step 5 spec.

**Smoke test (all 9 scenarios passed):**

```bash
EMAIL="user-$(date +%s)@test.com"
PASS="Strong1!Pass"

# 1. Signup
curl -X POST http://localhost:4000/v1/auth/signup -H "Content-Type: application/json" \
  -d "{\"name\":\"Test User\",\"email\":\"$EMAIL\",\"password\":\"$PASS\"}"
# → 201 { data: { user, agency, jwt } }

# 2. Grab the 6-digit code from backend terminal, then verify
curl -X POST http://localhost:4000/v1/auth/verify \
  -H "Authorization: Bearer $JWT" -d '{"code":"<6-digits>"}'
# → 200 { data: { jwt, user: { emailVerified: true } } }

# 3. Workspace setup
curl -X POST http://localhost:4000/v1/agencies/me \
  -H "Authorization: Bearer $JWT" \
  -d '{"name":"Nirvana Agency","country":"NP","billingEmail":"billing@nirvana.com"}'
# → 200 { data: { agency: { setupComplete: true }, jwt } }

# 4. whoami
curl http://localhost:4000/v1/auth/me -H "Authorization: Bearer $JWT"
# → 200 { data: { user, agency } }

# 5. Login (separate session)
curl -X POST http://localhost:4000/v1/auth/login \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}"
# → 200 { data: { jwt } }

# 6. Wrong password — generic error
# → 401 { error: { code: "invalid_credentials" } }

# 7. Forgot — silent 200
# → 200 { ok: true }

# 8. Reset with the token from email stub log
# → 200 { ok: true }

# 9. Login with new password works
# → 200 { data: { jwt } }
```

Server logs confirmed: verification codes + reset URLs printed to console; audit log rows written for every auth event (`auth.signup` / `auth.email_verified` / `auth.login` / `auth.failed_login` / `auth.password_reset_requested` / `auth.password_reset` / `auth.logout` / `agency.setup_complete`).

---

## Setup note for future contributors

When configuring `DATABASE_URL`, **use `127.0.0.1` not `localhost`** on Node 20+:

```env
# ❌ may fail with "Can't reach database server" on Node 20+ (IPv6 resolution gotcha)
DATABASE_URL="postgresql://you@localhost:5432/sendmymail_dev"

# ✅ works reliably
DATABASE_URL="postgresql://you@127.0.0.1:5432/sendmymail_dev"
```

---

### 2026-06-01 · 📋 Planning — scope locked, sub-PR 1 (foundation) ready to start

The 6 sub-PRs above are the plan. Sub-PR 1 lands with zero endpoints but the entire scaffolding so the remaining 5 are just route handlers using existing helpers.

**Sub-PR 1 estimated files (~10–12):**
- `src/lib/prisma.ts` — Prisma client singleton
- `src/lib/jwt.ts` — `issueJwt({ user, agency })`, `verifyJwt(token)`, claim types
- `src/lib/passwords.ts` — `hashPassword(plain)` / `verifyPassword(plain, hash)` / `validatePasswordStrength(plain)`
- `src/lib/tokens.ts` — `generateUrlToken()` / `hashToken(rawToken)`
- `src/lib/email.ts` — dev stub + signatures for the 3 transactional emails (verification, password reset, invitation)
- `src/lib/errors.ts` — `ApiError` class + `errorHandler` middleware matching api-conventions.md §4
- `src/lib/audit.ts` — `writeAudit({ agencyId, actorUserId, action, ... })` helper
- `src/middleware/auth.ts` — `requireAuth` / `requireRole(min)` / `requireClientScope` middleware
- `src/middleware/rateLimit.ts` — preset limiters (`signupLimiter`, `loginLimiter`, etc.)
- `src/types/express.d.ts` — extend Express `Request` with `req.auth` from the JWT
