# Loyalty engine

Owner: loyalty module (`apps/api/src/modules/loyalty/`). Schema: migrations `0006_loyalty.sql` and `0010_loyalty_engine.sql`.

## Principles

- **Configuration, not code.** Earning rates, bonuses, tiers, rounding, eligible spend, refund window and reward costs are rows in `loyalty_program_versions`, `loyalty_earning_rules`, `loyalty_tiers` and `rewards`. The engine has no business defaults: with no rules it awards nothing.
- **Points only from confirmed sales.** A connection code or association never awards points. The `loyalty.process_association` job runs only after association reconciliation has matched the sale in the POS data.
- **Append-only ledger.** `loyalty_ledger` rejects UPDATE and DELETE. Every correction is a new compensating entry that references the entry it reverses. Balances are sums over the ledger; `loyalty_balance_projections` is a rebuildable cache.
- **Idempotent.** Every ledger write carries an idempotency key (`earn:<sale>`, `bonus:<sale>`, `reversal:<sale>:<status>:<refunded>`, `redeem:<redemption>`, `redeem-reversal:<redemption>`, `adjustment:<request>`). Replaying any job is a no-op.
- **Versioned rules.** A purchase earns under the published version in effect at the time of purchase (retired versions still apply to their window). Reversals use the version and member terms captured on the original entry, so a later rule change never alters a refund.

## Earning

`evaluateEarning()` in `engine.ts` is a pure function:

1. Eligible spend = configured components (`subtotal`, minus `discount`, plus optional `tax`, `tip`, `service_charge`, `fee`), minus excluded products or categories, reduced in proportion to any refunded share of the sale. Voided sales have none.
2. Base points: the single highest-priority matching `base_rate` rule, `points_per_unit` × eligible major units × the member's tier multiplier.
3. Bonuses, each matching rule separately: `multiplier` (base × (m − 1)), `fixed_bonus`, `spend_threshold_bonus` (`conditions.minEligibleMinor`), `product_bonus` (per matching item quantity or spend), `visit_bonus` (every Nth qualifying visit in the period).
4. Rule conditions (`EarningRuleConditions`): `locationIds`, `regionIds` (cross-location rules), `tierRanks`, `productRefs`, `categories`, `minEligibleMinor`, `daysOfWeek` (location time zone), plus `starts_at`/`ends_at` and `status`.
5. Each line is rounded with the version's `rounding`.

The job writes an `earn` entry (base) and a `bonus` entry (sum of bonuses, with rule ids), records qualifying spend and one visit, sets `available_at = purchase + pendingPeriodSeconds`, and promotes the member's tier if the period's progress now meets a higher threshold.

Not earned, and logged to `integration_errors` (source `loyalty`): no active program, no version in effect at purchase time, or a sale currency different from the program's.

## Refunds and voids

A trigger on `pos_transactions` queues `loyalty.process_transaction_change` when a credited sale becomes partially refunded, refunded or voided. The job re-evaluates the sale in its new state under the original terms and appends a `refund_reversal` or `void_reversal` for the difference (points, qualifying spend and visit). If the original points were still pending, the reversal takes effect at the same time so the pending amount shrinks instead.

If the member already spent the points, the balance goes negative and future earning repays it. The wallet shows 0 available.

## Wallet and activity

- `availablePoints`: ledger sum of entries whose `available_at` has passed. `pendingPoints`: entries still in the refund window.
- Tier, next tier and progress use the qualification metric and period of the version in effect now (`calendar_year`, `rolling_12_months`, `lifetime`).
- `dataStatus` is `pending_updates` while one of the member's purchases awaits POS confirmation or the earning job.
- Activity merges a sale's earn and bonus rows into one item and adds unconfirmed purchases as `purchase_pending` with 0 points.

## Rewards and redemption

- Eligibility (`insufficient_points`, `tier_required`, `not_available_at_location`, `limit_reached`, `out_of_stock`, `not_yet_available`, `expired`) is computed server-side for the caller.
- Issuing debits the points at once (`redeem`), reserves inventory, and returns an 80-bit token shown as `XXXX-XXXX-XXXX-XXXX`. The token is derived with the server HMAC key from the redemption id, so it can be shown again to its owner and returned on an idempotent retry; only its SHA-256 is stored. It is never the four-digit connection code.
- Staff verify (read-only) and complete (exactly once, row-locked) at the issuing location with `rewards.redeem.verify`.
- Cancel by the member, or expiry (`loyalty.redemptions.sweep`, every minute), appends a `redeem_reversal` and releases inventory.

## Adjustments

A request (`loyalty.adjust.request`, at a location or organization-wide) changes nothing. A different person with `loyalty.adjust.approve` approves it, which appends an `adjustment` entry; a deduction may not take the available balance below zero. Rejections and approvals are audited.

## Reconciliation

`loyalty.reconcile` (hourly) recomputes every account from the ledger, records an integration error where the cached projection's time-independent totals had drifted, and rebuilds all projections.

## Open business questions

These need a decision from the organization before they can be configured:

- Tier downgrade: when a tier lapses (end of period, grace period, never).
- Points expiry: `pointsExpireAfterMonths` is recorded per entry; the expiring job needs the consumption order (oldest first is typical).
- Whether a refund after points were spent should claw back into a negative balance (current behaviour) or be absorbed.
- Reversing a completed redemption when its order is refunded.
