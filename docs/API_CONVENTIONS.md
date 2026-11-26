# API conventions (v1)

The contract of record is `packages/api-contracts/src/v1.ts`; `packages/api-contracts/openapi/v1.json` is generated from it (`pnpm openapi`) and CI fails if it is stale.

## Consuming from client repositories

- **Types and schemas:** depend on `@togiva/shared-types` and `@togiva/api-contracts` at a pinned version of togiva-core (a pnpm git dependency with a `path:` selector on a tag, or a GitHub Packages release once publishing is set up), or generate a typed client from `openapi/v1.json` at a pinned commit. Never copy core business code into a client repository.
- **Planned routes** (`status: "planned"`, `x-togiva-status: planned`) have fixed request/response shapes but return 404 until implemented. Build UI against them with mocks generated from the schema; do not invent alternative shapes.

## Rules

- Base path `/v1`. Breaking changes require `/v2`; additive changes (new optional fields, new routes, new error codes) stay in v1 and bump the contracts package minor version.
- Paths: customer self-service under `/v1/me/organizations/{organizationId}/...`; staff operations under `/v1/organizations/{organizationId}/locations/{locationId}/...` (location-scoped) or `/v1/organizations/{organizationId}/...` (org-scoped).
- Auth: `Authorization: Bearer <access token>` from the identity provider. Route `auth` is one of `public | user | customer | staff`; staff routes declare one `permission`, checked at the path's location.
- JSON camelCase. Timestamps ISO-8601 with offset. Money `{ amountMinor, currency }`. IDs are UUID strings. Codes are strings (`"0042"`), never numbers.
- Errors: `{ "error": { "code", "message", "requestId", "details"?, "retryAfterSeconds"? } }`. Clients branch on `code` (enum `ApiErrorCode`), never on message text. `429` includes a `Retry-After` header.
- Pagination: `?limit=&cursor=`; responses `{ items, nextCursor }` (null on last page). Cursors are opaque.
- Idempotency: mutating staff operations that can be retried at the counter take a body `idempotencyKey` (8 to 128 chars). Reuse it for retries of the same intent; a different intent with the same key returns `idempotency_conflict`.
- The server never trusts client-supplied amounts, balances, prices or permissions.
- Every response is validated against its contract in non-production environments.

## Browser clients (CORS)

Client web apps call the API from their own origins. `CORS_ALLOWED_ORIGINS` (comma-separated, exact match) lists them; other origins get no CORS headers. Credentials mode is never enabled because auth is a bearer token, not a cookie. Allowed request headers: `authorization`, `content-type`; exposed response header: `retry-after`.

Client apps are configured with an organization **slug**, not an id, and resolve it with `GET /v1/organizations/by-slug/{slug}` before sign-in.

## Implemented routes

| Route | Auth |
| --- | --- |
| `GET /v1/health` | public |
| `GET /v1/organizations/by-slug/{slug}` | public (active organizations only; public summary fields) |
| `GET /v1/me` | user |
| `POST /v1/me/organizations/{organizationId}/enrollment` | user |
| `GET /v1/organizations/{organizationId}/locations` | user |
| `GET /v1/organizations/{organizationId}/locations/{locationId}` | user |
| `POST /v1/me/organizations/{organizationId}/connection-codes` | customer |
| `GET /v1/me/organizations/{organizationId}/connection-codes/current` | customer |
| `DELETE /v1/me/organizations/{organizationId}/connection-codes/current` | customer |
| `POST /v1/organizations/{organizationId}/locations/{locationId}/connection-codes/lookup` | staff `customer.identify` |
| `POST .../connection-reservations/{reservationId}/release` | staff `customer.identify` |
| `POST .../connection-reservations/{reservationId}/associate` | staff `connection.associate` |
| `GET /v1/me/organizations/{organizationId}/wallet` | customer |
| `GET /v1/me/organizations/{organizationId}/activity` | customer |
| `GET /v1/me/organizations/{organizationId}/rewards` | customer |
| `POST /v1/me/organizations/{organizationId}/redemptions` | customer (idempotent; retry returns 200 with the same token) |
| `GET /v1/me/organizations/{organizationId}/redemptions` | customer |
| `GET /v1/me/organizations/{organizationId}/redemptions/{redemptionId}` | customer (re-show an unused token) |
| `DELETE /v1/me/organizations/{organizationId}/redemptions/{redemptionId}` | customer (points returned) |
| `POST /v1/organizations/{organizationId}/locations/{locationId}/redemptions/verify` | staff `rewards.redeem.verify` |
| `POST /v1/organizations/{organizationId}/locations/{locationId}/redemptions/complete` | staff `rewards.redeem.verify` |
| `POST /v1/organizations/{organizationId}/locations/{locationId}/loyalty/adjustments` | staff `loyalty.adjust.request` (at the location) |
| `POST /v1/organizations/{organizationId}/loyalty/adjustments` | staff `loyalty.adjust.request` (organization-wide) |
| `GET /v1/organizations/{organizationId}/loyalty/adjustments` | staff `loyalty.adjust.approve` |
| `POST /v1/organizations/{organizationId}/loyalty/adjustments/{adjustmentId}/decision` | staff `loyalty.adjust.approve`, not the requester |

Loyalty error codes: `loyalty_program_unavailable`, `insufficient_points`, `reward_unavailable` (with `details.reasons`), `redemption_invalid`, `redemption_expired`, `redemption_already_completed`, `redemption_wrong_location`. See `LOYALTY_ENGINE.md`.

## Not yet in the contract

Other routes the franchise and corporate apps need (staff management, analytics, campaigns, loyalty program and reward administration, POS settings, support cases) must be added to `v1.ts` by the owning module **before** UI work depends on them. See `MODULE_OWNERSHIP.md`.
