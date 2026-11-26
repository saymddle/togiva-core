import type { Queryable } from "@togiva/database";
import type { AdjustmentRequestSummary } from "@togiva/shared-types";
import { AppError } from "../../errors.js";
import type { JobHandler } from "../jobs/queue.js";
import { appendLedger, evaluateTier } from "./earning.js";
import { balanceOf, lockAccount, requireActiveProgram, versionAt } from "./program.js";

interface Row {
  id: string; organization_customer_id: string; location_id: string | null; points: string; qualifying_amount_minor: string; reason: string;
  status: AdjustmentRequestSummary["status"]; requested_by: string; reviewed_by: string | null; reviewed_at: Date | null; ledger_entry_id: string | null; created_at: Date;
}

const summary = (r: Row): AdjustmentRequestSummary => ({
  id: r.id, organizationCustomerId: r.organization_customer_id, locationId: r.location_id, points: Number(r.points), qualifyingAmountMinor: Number(r.qualifying_amount_minor),
  reason: r.reason, status: r.status, requestedBy: r.requested_by, reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at?.toISOString() ?? null,
  ledgerEntryId: r.ledger_entry_id, createdAt: r.created_at.toISOString(),
});

const SELECT = `select r.id, a.organization_customer_id, r.location_id, r.points, r.qualifying_amount_minor, r.reason, r.status, r.requested_by,
  r.reviewed_by, r.reviewed_at, r.ledger_entry_id::text, r.created_at
  from togiva.loyalty_adjustment_requests r join togiva.loyalty_accounts a on a.id = r.loyalty_account_id`;

/**
 * Manual point corrections. A request never changes a balance: a second
 * person with loyalty.adjust.approve must approve it, and only then is an
 * 'adjustment' entry appended. The requester can never approve their own
 * request (also enforced by a table constraint).
 */
export async function requestAdjustment(
  tx: Queryable, ctx: { userId: string }, organizationId: string,
  input: { organizationCustomerId: string; locationId?: string; points: number; qualifyingAmountMinor: number; reason: string; supportCaseId?: string },
): Promise<AdjustmentRequestSummary> {
  const program = await requireActiveProgram(tx, organizationId);
  const oc = await tx.query("select 1 from togiva.organization_customers where id = $1 and organization_id = $2", [input.organizationCustomerId, organizationId]);
  if (!oc.rowCount) throw new AppError("not_found", "Member not found");
  const account = await lockAccount(tx, organizationId, input.organizationCustomerId, program.id);
  const r = await tx.query<{ id: string }>(
    `insert into togiva.loyalty_adjustment_requests (organization_id, loyalty_account_id, location_id, points, qualifying_amount_minor, reason, support_case_id, requested_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [organizationId, account.id, input.locationId ?? null, input.points, input.qualifyingAmountMinor, input.reason, input.supportCaseId ?? null, ctx.userId],
  );
  const id = r.rows[0]!.id;
  await tx.query("select togiva.write_audit($1, 'loyalty.adjustment_requested', 'loyalty_adjustment_request', $2, $3, $4)",
    [organizationId, id, JSON.stringify({ points: input.points }), input.locationId ?? null]);
  return summary((await tx.query<Row>(`${SELECT} where r.id = $1`, [id])).rows[0]!);
}

export async function listAdjustments(tx: Queryable, organizationId: string, page: { cursor?: string; limit: number; status?: string }) {
  const cur = page.cursor ? Buffer.from(page.cursor, "base64url").toString().split("|") : null;
  const r = await tx.query<Row>(
    `${SELECT} where r.organization_id = $1 and ($2::text is null or r.status = $2)
       and ($3::timestamptz is null or (r.created_at, r.id) < ($3, $4::uuid))
     order by r.created_at desc, r.id desc limit $5`,
    [organizationId, page.status ?? null, cur?.[0] ?? null, cur?.[1] ?? null, page.limit + 1],
  );
  const rows = r.rows.slice(0, page.limit);
  const last = rows[rows.length - 1];
  return { items: rows.map(summary), nextCursor: r.rows.length > page.limit && last ? Buffer.from(`${last.created_at.toISOString()}|${last.id}`).toString("base64url") : null };
}

export async function decideAdjustment(tx: Queryable, ctx: { userId: string }, organizationId: string, requestId: string, decision: "approve" | "reject", note?: string): Promise<AdjustmentRequestSummary> {
  const r = await tx.query<{ id: string; loyalty_account_id: string; location_id: string | null; points: string; qualifying_amount_minor: string; status: string; requested_by: string }>(
    "select * from togiva.loyalty_adjustment_requests where id = $1 and organization_id = $2 for update", [requestId, organizationId]);
  const req = r.rows[0];
  if (!req) throw new AppError("not_found", "Adjustment request not found");
  if (req.status !== "pending") throw new AppError("conflict", "This request has already been decided");
  if (req.requested_by === ctx.userId) throw new AppError("forbidden", "Someone other than the requester must review this adjustment");

  if (decision === "reject") {
    await tx.query("update togiva.loyalty_adjustment_requests set status = 'rejected', reviewed_by = $2, reviewed_at = now() where id = $1", [req.id, ctx.userId]);
  } else {
    const a = (await tx.query("select * from togiva.loyalty_accounts where id = $1 for update", [req.loyalty_account_id])).rows[0];
    const account = { id: a.id, organizationId: a.organization_id, organizationCustomerId: a.organization_customer_id, programId: a.loyalty_program_id, currentTierId: a.current_tier_id, status: a.status, openedAt: a.opened_at };
    const points = Number(req.points);
    if (points < 0 && (await balanceOf(tx, account.id)).available + points < 0) {
      throw new AppError("insufficient_points", "This deduction is larger than the member's available points");
    }
    const entryId = await appendLedger(tx, {
      account, entryType: "adjustment", points, qualifyingAmountMinor: Number(req.qualifying_amount_minor), sourceType: "adjustment_request", sourceId: req.id,
      locationId: req.location_id, idempotencyKey: `adjustment:${req.id}`, occurredAt: new Date(), recordedBy: ctx.userId, metadata: { note: note ?? null },
    });
    await tx.query("update togiva.loyalty_adjustment_requests set status = 'applied', reviewed_by = $2, reviewed_at = now(), ledger_entry_id = $3 where id = $1", [req.id, ctx.userId, entryId]);
    await tx.query("select togiva.refresh_loyalty_projection($1)", [account.id]);
    const version = await versionAt(tx, account.programId, new Date());
    if (version) await evaluateTier(tx, account, version);
  }
  await tx.query("select togiva.write_audit($1, $2, 'loyalty_adjustment_request', $3, $4)",
    [organizationId, decision === "approve" ? "loyalty.adjustment_applied" : "loyalty.adjustment_rejected", req.id, JSON.stringify({ note: note ?? null })]);
  return summary((await tx.query<Row>(`${SELECT} where r.id = $1`, [req.id])).rows[0]!);
}

/**
 * Job 'loyalty.reconcile': rebuilds every balance projection from the ledger
 * and records an integration error wherever the cached totals had drifted.
 * Pending points maturing over time is expected and not reported; only the
 * time-independent totals are compared.
 */
export const reconcileLedger: JobHandler = async (tx) => {
  const drift = await tx.query<{ loyalty_account_id: string; organization_id: string; cached: string; actual: string }>(
    `select a.id as loyalty_account_id, a.organization_id,
            coalesce(p.available_points + p.pending_points, 0) || '/' || coalesce(p.lifetime_earned_points, 0) || '/' || coalesce(p.lifetime_redeemed_points, 0) as cached,
            (b.available_points + b.pending_points) || '/' || b.lifetime_earned_points || '/' || b.lifetime_redeemed_points as actual
       from togiva.loyalty_accounts a
       cross join lateral togiva.loyalty_ledger_balance(a.id) b
       left join togiva.loyalty_balance_projections p on p.loyalty_account_id = a.id
      where b.last_ledger_entry_id is not null
        and (p.loyalty_account_id is null or p.available_points + p.pending_points <> b.available_points + b.pending_points
             or p.lifetime_earned_points <> b.lifetime_earned_points or p.lifetime_redeemed_points <> b.lifetime_redeemed_points)`,
  );
  for (const d of drift.rows) {
    await tx.query(
      "insert into togiva.integration_errors (organization_id, source, error_code, message, details) values ($1, 'loyalty', 'loyalty_projection_drift', 'Cached balance differed from the ledger and was rebuilt', $2)",
      [d.organization_id, JSON.stringify({ loyaltyAccountId: d.loyalty_account_id, cached: d.cached, ledger: d.actual })],
    );
  }
  await tx.query("select togiva.refresh_loyalty_projection(id) from togiva.loyalty_accounts");
};
