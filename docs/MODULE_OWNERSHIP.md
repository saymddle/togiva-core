# Module ownership map

Each module has one owner (a workstream / thread). Only the owner edits its files. Changes to **shared contracts** (marked ★) go through the core architecture owner so parallel workstreams never diverge.

## togiva-core

| Module | Paths | Owner workstream | State |
| --- | --- | --- | --- |
| ★ Architecture and conventions | `docs/ARCHITECTURE.md`, `docs/API_CONVENTIONS.md`, root config | Core architecture | Done (Phase 1) |
| ★ Shared types | `packages/shared-types/src/**` | Core architecture (others propose via PR) | Done for Phase 1; loyalty/POS DTOs drafted |
| ★ API contracts | `packages/api-contracts/src/v1.ts`, `openapi/v1.json` | Core architecture; each module adds its own routes in a PR reviewed by core | v1 alpha |
| ★ Database schema and RLS | `packages/database/migrations/**` | Database and security | All domains created (Phase 1) |
| Database client, runner, fixtures | `packages/database/src/**` | Database and security | Done |
| Identity and access | `apps/api/src/auth/**`, `apps/api/src/modules/identity/**`, `apps/api/src/http/**` | Core architecture | Done (me, enrollment, JWT) |
| Organizations, locations, regions, franchise admin | `apps/api/src/modules/organizations/**` | Core architecture → Corporate workstream for admin endpoints | Read endpoints done; admin CRUD pending |
| Staff management | `apps/api/src/modules/staff/**` (new) | Franchise workstream (API) | Not started; schema + escalation guard done |
| Connection codes | `apps/api/src/modules/connection-codes/**` | Core architecture | Done end to end |
| Background jobs | `apps/api/src/modules/jobs/**`, `apps/api/src/worker.ts` | Core architecture | Done |
| Loyalty engine and rewards | `apps/api/src/modules/loyalty/**` (new) | Loyalty workstream | Not started; schema, config type and wallet/activity/rewards/redemption contracts fixed |
| POS framework + adapters | `apps/api/src/modules/pos/**`, later `packages/pos-*` | POS integration workstream | Not started; schema + `PosAdapter` + `NormalizedTransaction` fixed |
| Campaigns and offers | `apps/api/src/modules/campaigns/**` (new) | Corporate workstream (API) | Not started; schema done |
| Notifications | `apps/api/src/modules/notifications/**` (new) | Customer workstream (API) | Not started; schema done |
| Analytics aggregation | `apps/api/src/modules/analytics/**` (new) | Corporate workstream (API) | Not started; aggregate tables done |
| Support cases | `apps/api/src/modules/support/**` (new) | Franchise workstream (API) | Not started; schema done |
| Audit read API | `apps/api/src/modules/audit/**` (new) | Corporate workstream | Not started; `write_audit` done |
| QA and security tests | `**/test/**` cross-cutting suites | QA and security | Tenancy/RLS + connection suites exist |

## mr-cow-applications (for the client threads)

| Module | Owner workstream | Depends on |
| --- | --- | --- |
| `packages/brand-config` | Design system | Mr-Cow website tokens (`docs/REPOSITORY_ASSESSMENT.md`) |
| `packages/ui` | Design system | brand-config |
| `packages/api-client` | Core architecture (generated from `openapi/v1.json`) | api-contracts |
| `apps/customer-pwa` | Customer PWA | api-client, ui; connection-code routes are live |
| `apps/franchise-portal` | Franchise | api-client, ui; lookup/associate/release are live |
| `apps/corporate-console` | Corporate | api-client, ui; needs admin/analytics routes from core first |

## Rules for parallel work

1. Do not create tables, enums or routes outside your module. Need one? Open a PR that adds the migration / contract and tag the owner.
2. A new route is added to `v1.ts` first (with `status: "planned"`), merged, then implemented. Client UIs may build against planned contracts.
3. Every new table ships with RLS policies and a tenancy test in the same PR.
4. Shared enums live in `@togiva/shared-types` and must match database `check` constraints.
5. No business rule lives in a client repository. If a UI needs a computed value, the API returns it.
6. Update `docs/IMPLEMENTATION_STATUS.md` in the same PR that changes a module's state.
