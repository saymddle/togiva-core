# TOGIVA Core architecture

TOGIVA Core is a reusable, multi-tenant customer engagement platform. Client applications (the first is Mr. Cow, in `mr-cow-applications`) consume it only through its versioned HTTP API. This document is canonical: other threads and contributors follow it and escalate changes instead of inventing parallel patterns.

## Principles

1. **Core owns the data and the rules.** PostgreSQL schema, business logic, loyalty math, POS processing and authorization live here. Client apps never touch the database and never re-implement rules.
2. **No client specifics in core.** No brand, menu, reward names, tier names or policies in code or migrations. Those are organization configuration (data) or client-repo code.
3. **Modular monolith.** One deployable API, one worker, one database. Modules have owners and boundaries (see `MODULE_OWNERSHIP.md`); no microservices until measurement demands it.
4. **Defense in depth.** Every request is authorized in the API *and* by row-level security in Postgres, using the same SQL permission functions.
5. **Append-only money and points.** Ledger, audit and event tables reject UPDATE/DELETE; corrections are compensating entries.
6. **Configurable over hardcoded.** Earning rates, tiers, TTLs, rate limits and retention are data with documented defaults.
7. **Portability.** Supabase is the first host for Postgres and Auth. Nothing depends on Supabase-only features: tables live in schema `togiva`, auth is a JWT verifier interface, and the queue is plain Postgres.

## Repository layout

```
togiva-core/
├── apps/
│   └── api/                    Fastify API (src/server.ts) and job worker (src/worker.ts)
│       └── src/modules/        identity, organizations, connection-codes, jobs (+ future: loyalty, pos, campaigns, ...)
├── packages/
│   ├── shared-types/           @togiva/shared-types: zod schemas + TS types (published to clients)
│   ├── api-contracts/          @togiva/api-contracts: v1 route contracts + openapi/v1.json (published to clients)
│   └── database/               @togiva/database: migrations, runner, Database client, test fixtures
└── docs/
```

The brief's logical folders map as: `backend/`, `api/` → `apps/api`; `database/`, `migrations/` → `packages/database`; `shared-types/` → `packages/shared-types`; `authentication/`, `permissions/`, `loyalty-engine/`, `transaction-service/`, `pos-integrations/`, `campaigns/`, `notifications/`, `analytics/`, `background-jobs/` → modules under `apps/api/src/modules/` (extracted to `packages/` when a second deployable needs them); `documentation/` → `docs/`.

## Runtime

```
  Customer PWA ─┐                     ┌─────────────── TOGIVA Core ───────────────┐
  Franchise app ├── HTTPS + JWT ──▶   │  API (Fastify)        Worker (job queue)  │
  Corporate app ┘                     │     │  togiva_app (RLS)    │ togiva_service│
                                      │     ▼                      ▼               │
  Supabase Auth ◀── sign-up/login     │  PostgreSQL  schema togiva (RLS on all)    │
  (identity only)                     └────────────────────────────────────────────┘
  POS providers ── webhooks ──────▶ API (verify, persist) ──▶ queue ──▶ worker
```

- **Request path:** verify JWT → route contract parses input → staff routes check the contract's permission with `togiva.has_location_permission` / `has_org_permission` → service runs in a transaction as `togiva_app` with `togiva.set_request_context(user)` so RLS applies → responses are validated against the contract outside production.
- **Trusted path:** a few operations write tables the request role cannot (membership creation, ledger, POS data). They run as `togiva_service` after explicit authorization in code. Workers always use this role.

## Identity and authentication

- Supabase Auth handles registration, login, email verification, password recovery and session refresh. Client apps talk to Supabase Auth directly for those flows (anon key only; no data access).
- TOGIVA Core verifies the access token (`apps/api/src/auth/verifier.ts`, HS256 secret or JWKS) and trusts only `sub` (UUID) and email claims. Swapping providers means implementing `IdentityVerifier`.
- `user_profiles.id` = identity subject. `GET /v1/me` provisions the row on first call and returns roles and effective permissions for role-based navigation.
- One global `customer_profiles` row per person; one `organization_customers` row per organization joined. Consents, balances and history hang off the organization membership.

## Tenancy

See `SECURITY_AND_TENANCY.md`. Summary: shared database with `organization_id` on every tenant table, composite `(organization_id, id)` foreign keys so rows cannot reference another tenant's parent, and RLS on every table. `organizations.infrastructure_mode` (`shared` | `dedicated`) records the intent to move a client to its own database later; the code has no cross-tenant joins that would block that.

## Loyalty engine (Phase 4 design, schema in place)

- `loyalty_programs` → immutable published `loyalty_program_versions` (config: eligible amount components, rounding, expiry, qualification metric/period, pending period) → `loyalty_tiers` (rank 1..n, names are configuration) and `loyalty_earning_rules` (base rate, multipliers, bonuses, product/location/tier/time conditions).
- Input is only POS-confirmed data: a `customer_transaction_associations` row in `confirmed` plus its `pos_transactions` row. The connection workflow enqueues `loyalty.process_association`; the loyalty worker computes eligible spend from the normalized transaction and the program version in effect at purchase time.
- Output is `loyalty_ledger` entries with idempotency keys like `earn:<pos_transaction_id>` (unique per organization), so a transaction can never earn twice. Refunds/voids post `refund_reversal`/`void_reversal` entries. Redemptions post `redeem` debits; cancellations post `redeem_reversal`.
- `loyalty_balance_projections` and `loyalty_qualification_progress` are rebuildable read models. Redeemable points and qualifying spend are separate columns, so redeeming never reduces tier progress.
- Redemption tokens (`reward_redemptions.token_hash`) are high-entropy and separate from connection codes.

## POS integration framework (Phase 7 design, schema and interface in place)

- `PosAdapter` interface in `@togiva/shared-types` (`pos.ts`): webhook verification/parsing, fetch/list transactions into `NormalizedTransaction`, optional customer attach. `PosCapabilities` declares what is verified; unverified capabilities must be `false`.
- Pipeline: webhook → verify signature → persist `pos_webhook_events` (unique per provider event id, so duplicates are no-ops) → job → adapter fetches/normalizes → upsert `pos_transactions` keyed by `(organization_id, provider_code, external_transaction_id)`, ignoring stale updates via `provider_updated_at` → enqueue `connection_association.reconcile` for matching pending associations and loyalty processing.
- POS is authoritative for the sale; TOGIVA for membership and points. Card data is never stored. Credentials are AES-GCM encrypted by the app and not readable by the request role.
- Clover is the first adapter. Nothing about Clover's API has been verified in this phase; the adapter must be built from https://docs.clover.com/ with capabilities marked verified only after sandbox testing.
- A `fixture` provider exists for development and tests only.

## Background jobs

`background_jobs` + `JobWorker` (`apps/api/src/modules/jobs/queue.ts`): `FOR UPDATE SKIP LOCKED` claiming, exponential backoff, lease expiry for crashed workers, `dead` status plus an `integration_errors` row after max attempts. Jobs are enqueued via `togiva.enqueue_job(type, payload, org, idempotency_key)`; a duplicate idempotency key returns the existing job. A worker only claims job types it has handlers for, so jobs for not-yet-deployed modules wait durably.

## Analytics

Dashboards read `*_daily_metrics` and `*_aggregates` tables produced by jobs from operational data, each with `data_status` (`estimated` | `finalized`). No warehouse yet; the aggregate tables are the seam where one would attach.

## Environments

`development` (local Postgres or local Supabase), `staging`, `production`, each with its own database, auth project, HMAC keys and POS credentials. Migrations run with `pnpm db:migrate` against `DATABASE_MIGRATION_URL` (direct connection), forward-only, checksum-verified.

## Decisions log

| # | Decision | Why |
| --- | --- | --- |
| D1 | Tables in schema `togiva`, not `public` | Supabase exposes `public` through PostgREST; core data must not be browser-reachable. |
| D2 | Plain SQL migrations + tiny runner, no ORM | Portable, reviewable, RLS/policies/functions are first-class. |
| D3 | Permission resolution in SQL (`permitted_location_ids`) used by both RLS and API | One implementation of "who can do what where". |
| D4 | Money as integer minor units + ISO currency | No floating point in financial paths. |
| D5 | Connection codes hashed with HMAC(server key, org, location, code) | 4 digits are trivially brute-forced if unsalted; binding location scopes the code. |
| D6 | Code consumed at association; points only after POS confirmation | Identification and sale confirmation are separate facts. |
| D7 | Postgres job queue | Durable, transactional enqueue with the business write, no extra infrastructure. |
| D8 | zod v4 for contracts, OpenAPI generated and committed | Single source for validation, types, and client generation. |
