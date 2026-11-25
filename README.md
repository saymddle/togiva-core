# TOGIVA Core

Reusable, multi-tenant platform for customer recognition, membership, loyalty, POS-connected purchases and franchise operations. Client applications (first: Mr. Cow, in `saymddle/mr-cow-applications`) use it only through its versioned API.

## Contents

| Path | What |
| --- | --- |
| `apps/api` | Fastify API (`src/server.ts`) and background worker (`src/worker.ts`) |
| `packages/database` | PostgreSQL migrations, migration runner, database client, test fixtures |
| `packages/shared-types` | `@togiva/shared-types`: canonical domain types and zod schemas |
| `packages/api-contracts` | `@togiva/api-contracts`: v1 route contracts and `openapi/v1.json` |
| `docs/` | Architecture, database, security, API conventions, connection codes, ownership map, status |

Start with `docs/ARCHITECTURE.md`, then `docs/IMPLEMENTATION_STATUS.md` and `docs/MODULE_OWNERSHIP.md`.

## Development

Requirements: Node 22+, pnpm 10, PostgreSQL 15+ (16 recommended).

```bash
pnpm install
cp .env.example .env               # fill in secrets
createdb togiva_dev
pnpm db:migrate                    # uses DATABASE_MIGRATION_URL or DATABASE_URL
psql togiva_dev -c "grant togiva_app, togiva_service to current_user"
pnpm db:seed:dev                   # synthetic fixtures, refuses NODE_ENV=production
pnpm build
pnpm dev:api                       # http://localhost:4000/v1/health
pnpm dev:worker
```

Tests need a Postgres where the user can create databases (each test file gets a fresh, migrated database):

```bash
TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres pnpm test
```

After changing `packages/api-contracts/src`, run `pnpm openapi` and commit `openapi/v1.json` (CI checks it).

## Environment

See `.env.example`. Key variables: `DATABASE_URL`, `DATABASE_MIGRATION_URL`, `AUTH_JWT_SECRET` or `AUTH_JWKS_URL`, `AUTH_ISSUER`, `AUTH_AUDIENCE`, `CONNECTION_CODE_HMAC_KEYS`, `CONNECTION_CODE_ACTIVE_KEY_VERSION`.

## Deployment

Not configured yet. Intended shape: one API service and one worker service from this repository, separate development/staging/production databases (Supabase Postgres with PITR) and auth projects, migrations run as a release step with the direct connection string. See `docs/IMPLEMENTATION_STATUS.md` for what is still needed.

## Rules

No client branding, menus, reward names or business policies in this repository. Those are organization configuration or client-repository code.

## Project portal

`apps/portal` builds a static site from `docs/`, recent commits and the
OpenAPI document (`node apps/portal/build.mjs` → `apps/portal/dist`). Vercel
rebuilds it on every push, so each branch has a viewable page with the
current implementation status, design docs and API reference.
