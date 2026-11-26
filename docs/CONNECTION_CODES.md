# Four-digit membership connection code

Status: **implemented end to end in TOGIVA Core** (issue, lookup/reserve, release, associate, POS reconciliation, expiry sweeper). Points are awarded by the loyalty engine (Phase 4) from confirmed associations; the hand-off job is already enqueued.

The code identifies a member at the counter. It is not a login, payment, redemption or authorization credential, and entering it never awards points. There is no customer-facing QR code in this workflow.

## Flow

```
Customer PWA                TOGIVA Core                                   Cashier (franchise app)
   │ POST /v1/me/organizations/{org}/connection-codes {locationId}
   │ ─────────────────────▶ revoke previous active code
   │                        generate 0000-9999 (crypto.randomInt)
   │                        store HMAC only, expires in 5 min (configurable)
   │ ◀───────────────────── { code: "0871", expiresAt, location }
   │  shows code + countdown + location name
   │                                                     POST .../locations/{loc}/connection-codes/lookup {code, idempotencyKey, terminalId}
   │                        lockout check → expire stale → atomic UPDATE active→reserved
   │                        ─────────────────────────────▶ { reservationId, customer: firstName, status, last4, tier }
   │                                                     POST .../connection-reservations/{id}/associate {method, provider, externalOrderId|...}
   │                        insert association (pending_pos_confirmation), code reserved→consumed,
   │                        audit, enqueue connection_association.reconcile
   │ GET .../connection-codes/current  → status consumed, association pending  ("Purchase pending")
   │                        worker: POS transaction ingested? paid→confirmed, voided→rejected,
   │                                missing→retry with backoff, >24h→needs_review + integration error
   │                        confirmed → enqueue loyalty.process_association (Phase 4 awards points)
   │ GET .../current → association confirmed; wallet/activity (Phase 4) shows points
```

## Lifecycle

`active → reserved → consumed`, `active → expired | revoked`, `reserved → active` (cashier released, or reservation lapsed while the code is still valid), `reserved → expired` (lapsed after code expiry).

| Rule | Where enforced |
| --- | --- |
| Exactly 4 ASCII digits, leading zeros kept | `ConnectionCodeDigits` (zod), `generateCode()` |
| Cryptographically secure | `crypto.randomInt(0, 10000)` |
| Raw code never stored | Only `code_hash` (HMAC-SHA256, 32 bytes) + `key_version` |
| Code scoped to organization + location | Both are inside the HMAC input; lookups filter by location too |
| One active code per customer per organization | Unique partial index `connection_codes_one_active` + per-customer advisory lock |
| Live digits unique per location | Unique partial index `connection_codes_live_hash`; generator redraws on collision (25 tries, then 503) |
| Replacement / location change invalidates old code | `issue()` revokes previous active code (`replaced` / `location_changed`) |
| Reserved code survives a new code mid-checkout | Only `active` codes are revoked on re-issue |
| Expired or consumed codes cannot be reused | Status checks in the atomic UPDATE; consumed is terminal |
| Concurrent lookups: one winner | Single `UPDATE ... WHERE status='active' AND expires_at>now()` row lock |
| Only the reserving cashier can release/associate | Service check + DB transition guard |
| One order, one member | Unique partial indexes on `(org, provider, external_order_id)` and `(org, pos_transaction_id)` |
| Idempotent retries | Lookup: `reservation_idempotency_key`; associate: `(org, idempotency_key)` |
| Brute force | 5 failures per employee per location in 10 min → 15 min lockout; 30 per location → location lockout (all configurable in `organization_settings`) |
| Minimal disclosure | `togiva.connection_code_customer_summary()` returns first name, membership status, last 4 of membership number, tier name, only to the reserving cashier with `customer.identify` |
| Defense in depth | RLS + `guard_connection_code_transition` trigger: customers can only revoke; staff can only reserve/release/consume what they reserved, at locations they are permitted |
| Audit | Every step appends to `customer_connection_events`; associations also go to `audit_logs` |

Issuing is intentionally not idempotent: the raw code is never stored, so a retry issues a fresh code and revokes the one the customer never saw.

## Settings (per organization, `organization_settings`)

| Column | Default |
| --- | --- |
| `connection_code_ttl_seconds` | 300 |
| `connection_code_reservation_ttl_seconds` | 600 |
| `connection_code_issue_limit_per_window` | 10 per failure window |
| `connection_code_employee_failure_limit` | 5 |
| `connection_code_location_failure_limit` | 30 |
| `connection_code_failure_window_seconds` | 600 |
| `connection_code_lockout_seconds` | 900 |

HMAC keys: `CONNECTION_CODE_HMAC_KEYS="1:<b64>,2:<b64>"`, `CONNECTION_CODE_ACTIVE_KEY_VERSION`. Lookups try every configured key, so rotation is: add new key, switch active version, remove the old key after one TTL.

## Association methods (POS fallbacks)

| `method` | Use when |
| --- | --- |
| `pos_customer_attach` | The POS adapter can attach a customer to an open order (`PosCapabilities.customerAttachToOpenOrder`). **Not verified for Clover yet.** |
| `order_reference` | Cashier enters/scans the POS order number shown on the register. Default fallback. |
| `recent_transaction_select` | Cashier picks the sale from a recent-transactions list at their location (`posTransactionId`). The list endpoint is POS-module work (Phase 7). |

Cashiers never type a purchase amount. The amount always comes from the POS.

## Failure scenarios and recovery

| Scenario | Behaviour | Cashier/customer message |
| --- | --- | --- |
| Invalid digits | 404 `connection_code_invalid`, counts toward lockout | "Ask the customer to check the location shown with their code, or refresh it." |
| Expired | 410 `connection_code_expired` | "Ask the customer to refresh it." |
| Replaced code entered | 404 `connection_code_invalid` | same as invalid |
| Duplicate lookup (same cashier, same key) | Same reservation returned | none |
| Simultaneous lookups | One 200, others 409 `connection_code_already_used` | "Already being used for another checkout." |
| Unauthorized employee / wrong location / other org | 403 before any code is touched | — |
| Customer's code is for another store | 404 at this store; code stays active for its store | Customer sees the store name next to the code |
| Reservation timed out | 410 `connection_code_reservation_expired`; code returns to active if still valid | "Look the code up again." |
| Order already linked to a member | 409 `order_already_associated`; reservation kept for the right order | — |
| POS outage / delayed webhook | Association stays `pending_pos_confirmation`; job retries with backoff | PWA shows "Purchase pending", not points |
| Duplicate webhook | Raw event unique per provider event id; reconcile is idempotent; loyalty hand-off has idempotency key | — |
| Voided sale | Association `rejected` (`transaction_voided`), no points | — |
| Refund | Association `confirmed`; loyalty engine posts reversal entries | — |
| Sale never arrives | After 24h → `needs_review` + `integration_errors` row for reconciliation | Corporate/franchise support queue |
| Same sale confirmed for two members | Second goes to `needs_review` (`transaction_already_associated`), never double credit | — |

## Tests

`apps/api/test/connection-codes.test.ts` (29 tests) and `identity-and-locations.test.ts` cover: valid, invalid, leading zero, malformed, expiration, replacement, location change, reuse, concurrent issue, concurrent lookup, rate limit, lockout, wrong location, unauthorized employee (other location, other org, analyst, customer, anonymous), idempotent lookup and association, release, duplicate transaction, delayed POS event, duplicate reconcile (webhook), void, refund, failed association to review, new code mid-checkout, reservation timeout, wrong cashier, sweeper, raw code never stored, no ledger rows before POS confirmation, DB-level guard against customers consuming/extending codes and staff touching other locations' codes.

## For the client apps

- PWA: `issueConnectionCode`, poll `getCurrentConnectionCode` (every few seconds while the code screen is open) for `reserved` → `consumed` → association `confirmed`; `cancelConnectionCode` on leave. Show the location name and a countdown from `expiresAt` (server time). Never cache the code offline.
- Franchise app: `lookupConnectionCode` (generate one `idempotencyKey` per attempt and reuse it on network retry), then `associateOrder` or `releaseConnectionReservation`. Map error `code`s to the messages above.
