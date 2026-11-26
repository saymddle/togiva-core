# Implementation status

Last updated: 2026-11-26 (Phase 0, Phase 1, core support for Phase 2, Phase 4 loyalty engine part 1). Update this file in the same PR that changes a module's state.

Legend: ✅ implemented and tested · 🟨 schema/contract fixed, implementation pending · ⬜ not started

## Phase 0: repository inspection ✅

See `REPOSITORY_ASSESSMENT.md`. Both project repositories were empty. The Mr. Cow website (`saymddle/Mr-Cow`) was inspected and its brand tokens recorded; it is not in the project's repository list.

## Phase 1: TOGIVA Core foundation

| Area | State | Notes |
| --- | --- | --- |
| Monorepo (pnpm, Turborepo, TypeScript, Vitest), CI workflow | ✅ | `.github/workflows/ci.yml` runs build, typecheck, tests against Postgres 16, OpenAPI drift check |
| PostgreSQL schema, all domains (76 tables) | ✅ | 9 migrations; see `DATABASE.md` |
| Migration runner (forward-only, checksums, advisory lock) | ✅ | `pnpm db:migrate` |
| Roles, permissions, permission resolution functions | ✅ | 8 actor types, 32 permissions |
| Row-level security on every table | ✅ | Tested |
| Tenant isolation | ✅ | Composite FKs + RLS; tested |
| Privilege-escalation guards | ✅ | Tested |
| Authentication (JWT verification, Supabase-compatible) | ✅ | Registration/login/verification/recovery are Supabase Auth flows called by client apps |
| `GET /v1/me` with effective permissions | ✅ | Drives role-based navigation |
| Customer enrollment (global identity + org membership) | ✅ | |
| Locations read API | ✅ | Admin CRUD pending (corporate workstream) |
| Public organization lookup by slug (for client apps) | ✅ | `GET /v1/organizations/by-slug/{slug}`, active orgs only |
| CORS allow list for client web apps | ✅ | `CORS_ALLOWED_ORIGINS` |
| Audit logging (`write_audit`, append-only) | ✅ | Audit read API pending |
| Durable background jobs + worker | ✅ | Retries, backoff, dead-letter alert, lease expiry |
| Shared types + API contracts v1 + OpenAPI | ✅ | `1.0.0-alpha.1` |
| **Connection code service** (issue, lookup, reserve, release, associate, POS reconcile, sweeper) | ✅ | See `CONNECTION_CODES.md` |
| Dev fixtures (synthetic org, no client data) | ✅ | `pnpm db:seed:dev` |

## Phase 2: Mr. Cow application foundation ✅

Built in `saymddle/mr-cow-applications`: customer PWA, franchise portal and corporate console shells, brand configuration from the Mr. Cow website, shared UI, a typed API client generated from this repository's OpenAPI document, Supabase Auth sign-in and role-based navigation from `/v1/me`. See that repository's `docs/IMPLEMENTATION_STATUS.md`.

## Phase 4: loyalty engine (part 1) ✅

See `LOYALTY_ENGINE.md`.

| Area | State | Notes |
| --- | --- | --- |
| Earning evaluator: base rate, multipliers, fixed/threshold/product/visit bonuses, tier multiplier, location/region/day/tier conditions | ✅ | Pure function, `apps/api/src/modules/loyalty/engine.ts` |
| Points from POS-confirmed purchases (`loyalty.process_association`) | ✅ | Idempotent per sale; version in effect at purchase time |
| Pending window (refund window) before points are spendable | ✅ | `pendingPeriodSeconds` per version |
| Tier progression (promotion) | ✅ | Downgrade policy not configurable yet (see open questions) |
| Refund and void reversals (`loyalty.process_transaction_change`) | ✅ | Trigger on `pos_transactions`; compensating entries only |
| Wallet, activity, rewards catalog with server-side eligibility | ✅ | |
| Redemption tokens: issue, re-show, cancel, staff verify/complete, expiry sweep, inventory | ✅ | 80-bit token, only SHA-256 stored |
| Manual adjustments with two-person approval | ✅ | |
| Ledger reconciliation (`loyalty.reconcile`, hourly) | ✅ | |
| Points expiry job | ⬜ | `points_expire_at` is recorded; the expiring job needs a business rule (FIFO etc.) |
| Loyalty program, tier, rule and reward administration API (corporate console) | ⬜ | Next; until then configure with SQL or the dev seed |
| Reversing a completed redemption (e.g. refunded order) | ⬜ | |

## Later phases (core side)

| Area | State | Owner |
| --- | --- | --- |
| Staff management API (invite, assign, deactivate) | 🟨 schema + guards | Franchise |
| Organization/location/region/franchise admin API | 🟨 schema | Corporate |
| Campaigns and offers | 🟨 schema | Corporate |
| Analytics aggregation jobs + reporting API | 🟨 tables | Corporate |
| Notifications (email/push providers) | 🟨 schema | Customer |
| Support cases API | 🟨 schema | Franchise |
| POS framework: webhook intake, normalization, sync, reconciliation | 🟨 schema + `PosAdapter` interface | POS |
| Clover adapter (OAuth, webhooks, orders, refunds) | ⬜ nothing verified against Clover docs or sandbox yet | POS |
| Credential encryption helper (AES-GCM) for POS secrets | ⬜ | POS |
| Data-retention purge jobs, support-access workflow | ⬜ | Security |
| Deployment (staging/prod), monitoring, backups/PITR, restore tests | ⬜ | DevOps |

## Tests (2026-11-26)

`pnpm test` with `TEST_DATABASE_URL` pointing at Postgres 16: **101 passed, 0 failed**.

| Suite | Tests |
| --- | --- |
| `packages/database/test/tenancy-and-rls.test.ts` | 16 |
| `packages/shared-types/src/connection-codes.test.ts` | 11 |
| `packages/api-contracts/src/openapi.test.ts` | 3 |
| `apps/api/test/connection-codes.test.ts` | 29 |
| `apps/api/test/identity-and-locations.test.ts` | 13 |
| `apps/api/test/client-access.test.ts` | 6 |
| `apps/api/test/loyalty-engine.test.ts` | 11 |
| `apps/api/test/loyalty.test.ts` | 12 |

Also verified manually: migrations apply on an empty database and are idempotent on rerun; dev fixtures load; the API process starts, `/v1/health` reports the database, and a real token issued a code (`0871`, leading zero preserved) through HTTP.

## Assumptions

- Supabase Auth is the identity provider for the first release; token `sub` is a UUID used as `user_profiles.id`.
- Connection code TTL 5 min, reservation 10 min, lockouts as in `CONNECTION_CODES.md`; all configurable per organization.
- A code is consumed when the cashier associates an order; points come only after POS confirmation.
- Associations not confirmed by the POS within 24 hours go to human review.
- Customers may browse any active, loyalty-participating location (store info is public).
- Loyalty: refunds reduce points proportionally to the refunded share of the sale; a refund after the points were spent leaves a negative balance that later earning repays (the ledger stays true; the wallet shows 0).
- Loyalty: tiers are promoted automatically and never lowered automatically until a downgrade policy is decided.
- Loyalty: a sale confirmed while the organization has no active program, or no version in effect, earns nothing and is logged as an integration error.
- Mr. Cow will be created as an organization record through onboarding; nothing Mr. Cow-specific is in this repository.

## External dependencies still needed

- Supabase projects (dev/staging/prod) or equivalent Postgres + Auth, with JWT secret or JWKS URL.
- Production secret store for `CONNECTION_CODE_HMAC_KEYS` and the POS credential key.
- Clover developer account, sandbox merchant and app credentials, and Mr. Cow merchant authorization for production.
- Mr. Cow business inputs: loyalty earning rates, tier names/thresholds, reward catalog, real location list and franchise ownership records.
- Hosting target for the API and worker.
