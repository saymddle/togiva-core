import { randomUUID } from "node:crypto";
import type { Queryable } from "@togiva/database";
import type { CustomerRedemption, IssuedRedemption, RedemptionVerification } from "@togiva/shared-types";
import { AppError } from "../../errors.js";
import { tokenHash, type RedemptionTokens } from "../connection-codes/crypto.js";
import type { JobHandler } from "../jobs/queue.js";
import { REWARD_SELECT, rewardEligibility, type RewardRow } from "./customer.js";
import { appendLedger } from "./earning.js";
import { balanceOf, findAccount, lockAccount, memberOf, requireActiveProgram, tierRankOf, type Account } from "./program.js";

interface RedemptionRow {
  id: string; organization_id: string; reward_id: string; loyalty_account_id: string; location_id: string; status: IssuedRedemption["status"];
  token_hash: Buffer; points_cost: string; issued_at: Date; expires_at: Date; completed_at: Date | null; idempotency_key: string;
}

async function adjustInventory(tx: Queryable, rewardId: string, locationId: string, change: "reserve" | "release" | "redeem"): Promise<boolean> {
  const set = change === "reserve" ? "quantity_reserved = quantity_reserved + 1"
    : change === "release" ? "quantity_reserved = greatest(quantity_reserved - 1, 0)"
    : "quantity_reserved = greatest(quantity_reserved - 1, 0), quantity_redeemed = quantity_redeemed + 1";
  const guard = change === "reserve" ? "and quantity_reserved + quantity_redeemed < quantity_total" : "";
  const scopes = await tx.query<{ id: string }>("select id from togiva.reward_inventory where reward_id = $1 and (location_id is null or location_id = $2)", [rewardId, locationId]);
  for (const s of scopes.rows) {
    const r = await tx.query(`update togiva.reward_inventory set ${set} where id = $1 ${guard}`, [s.id]);
    if (!r.rowCount) return false;
  }
  return true;
}

/** Returns a redemption's points to the member (cancelled by the member, or expired unused). */
async function returnPoints(tx: Queryable, red: RedemptionRow, newStatus: "cancelled" | "expired") {
  const acct = await tx.query("select * from togiva.loyalty_accounts where id = $1 for update", [red.loyalty_account_id]);
  const a = acct.rows[0];
  const account: Account = { id: a.id, organizationId: a.organization_id, organizationCustomerId: a.organization_customer_id, programId: a.loyalty_program_id, currentTierId: a.current_tier_id, status: a.status, openedAt: a.opened_at };
  const debit = await tx.query<{ id: string }>("select id from togiva.loyalty_ledger where organization_id = $1 and idempotency_key = $2", [red.organization_id, `redeem:${red.id}`]);
  const entryId = await appendLedger(tx, {
    account, entryType: "redeem_reversal", points: Number(red.points_cost), sourceType: "reward_redemption", sourceId: red.id, locationId: red.location_id,
    reversesEntryId: debit.rows[0]?.id ?? null, idempotencyKey: `redeem-reversal:${red.id}`, occurredAt: new Date(), metadata: { reason: newStatus },
  });
  await tx.query("update togiva.reward_redemptions set status = $2, reversal_ledger_entry_id = $3 where id = $1", [red.id, newStatus, entryId]);
  await adjustInventory(tx, red.reward_id, red.location_id, "release");
  await tx.query("select togiva.refresh_loyalty_projection($1)", [account.id]);
}

export class RedemptionService {
  constructor(private readonly tokens: RedemptionTokens) {}

  private issued(red: RedemptionRow): IssuedRedemption {
    const token = this.tokens.reveal(red.id, red.token_hash);
    if (!token) throw new AppError("internal_error", "Redemption token cannot be shown");
    return { id: red.id, rewardId: red.reward_id, locationId: red.location_id, status: red.status, token, pointsCost: Number(red.points_cost), expiresAt: red.expires_at.toISOString() };
  }

  /**
   * Reserves the reward's points immediately (a 'redeem' debit) and returns a
   * high-entropy token for the cashier. The 4-digit connection code is never
   * used for redemption. If the token is not used before it expires, the
   * sweep returns the points.
   */
  async issue(tx: Queryable, userId: string, organizationId: string, input: { rewardId: string; locationId: string; idempotencyKey: string }): Promise<{ created: boolean; redemption: IssuedRedemption }> {
    const member = await memberOf(tx, userId, organizationId);
    const program = await requireActiveProgram(tx, organizationId);
    const account = await lockAccount(tx, organizationId, member.id, program.id);

    const prior = await tx.query<RedemptionRow>("select * from togiva.reward_redemptions where organization_id = $1 and idempotency_key = $2", [organizationId, `${member.id}:${input.idempotencyKey}`]);
    if (prior.rows[0]) {
      const p = prior.rows[0];
      if (p.reward_id !== input.rewardId || p.location_id !== input.locationId) throw new AppError("idempotency_conflict", "This idempotency key was used for a different reward");
      return { created: false, redemption: this.issued(p) };
    }
    if (account.status !== "active") throw new AppError("conflict", "This rewards account cannot redeem right now. Contact support.");

    const loc = await tx.query("select 1 from togiva.locations where id = $1 and organization_id = $2 and status = 'active' and loyalty_participating", [input.locationId, organizationId]);
    if (!loc.rowCount) throw new AppError("location_not_participating", "That location is not participating");
    const rr = await tx.query<RewardRow>(`${REWARD_SELECT} where r.id = $1 and r.loyalty_program_id = $2 and r.status = 'active' for update of r`, [input.rewardId, program.id]);
    const reward = rr.rows[0];
    if (!reward) throw new AppError("not_found", "Reward not found");

    const available = (await balanceOf(tx, account.id)).available;
    const reasons = await rewardEligibility(tx, reward, { account, available, tierRank: await tierRankOf(tx, account.currentTierId), locationId: input.locationId });
    if (reasons.length === 1 && reasons[0] === "insufficient_points") throw new AppError("insufficient_points", "Not enough points for this reward yet", { details: { reasons } });
    if (reasons.length) throw new AppError("reward_unavailable", "This reward is not available to you right now", { details: { reasons } });

    const id = randomUUID();
    const { token, hash } = this.tokens.issue(id);
    if (!(await adjustInventory(tx, reward.id, input.locationId, "reserve"))) throw new AppError("reward_unavailable", "This reward is out of stock", { details: { reasons: ["out_of_stock"] } });
    const cost = Number(reward.points_cost);
    const ins = await tx.query<RedemptionRow>(
      `insert into togiva.reward_redemptions (id, organization_id, reward_id, loyalty_account_id, location_id, token_hash, points_cost, idempotency_key, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(secs => $9)) returning *`,
      [id, organizationId, reward.id, account.id, input.locationId, hash, cost, `${member.id}:${input.idempotencyKey}`, reward.redemption_ttl_seconds],
    );
    if (cost > 0) {
      const entryId = await appendLedger(tx, {
        account, entryType: "redeem", points: -cost, sourceType: "reward_redemption", sourceId: id, locationId: input.locationId,
        idempotencyKey: `redeem:${id}`, occurredAt: new Date(), metadata: { rewardId: reward.id },
      });
      await tx.query("update togiva.reward_redemptions set debit_ledger_entry_id = $2 where id = $1", [id, entryId]);
      await tx.query("select togiva.refresh_loyalty_projection($1)", [account.id]);
    }
    await tx.query("select togiva.write_audit($1, 'loyalty.redemption_issued', 'reward_redemption', $2, $3, $4)",
      [organizationId, id, JSON.stringify({ rewardId: reward.id, pointsCost: cost }), input.locationId]);
    return { created: true, redemption: { ...this.issued(ins.rows[0]!), token } };
  }

  async listMine(tx: Queryable, userId: string, organizationId: string, page: { cursor?: string; limit: number; status?: string }) {
    const member = await memberOf(tx, userId, organizationId);
    const program = await requireActiveProgram(tx, organizationId);
    const account = await findAccount(tx, member.id, program.id);
    if (!account) return { items: [], nextCursor: null };
    const cur = page.cursor ? Buffer.from(page.cursor, "base64url").toString().split("|") : null;
    const r = await tx.query<RedemptionRow & { reward_name: string }>(
      `select rr.*, rw.name as reward_name from togiva.reward_redemptions rr join togiva.rewards rw on rw.id = rr.reward_id
        where rr.loyalty_account_id = $1 and ($2::text is null or rr.status = $2)
          and ($3::timestamptz is null or (rr.issued_at, rr.id) < ($3, $4::uuid))
        order by rr.issued_at desc, rr.id desc limit $5`,
      [account.id, page.status ?? null, cur?.[0] ?? null, cur?.[1] ?? null, page.limit + 1],
    );
    const rows = r.rows.slice(0, page.limit);
    const items: CustomerRedemption[] = rows.map((x) => ({
      id: x.id, rewardId: x.reward_id, rewardName: x.reward_name, locationId: x.location_id, status: x.status, pointsCost: Number(x.points_cost),
      expiresAt: x.expires_at.toISOString(), completedAt: x.completed_at?.toISOString() ?? null,
    }));
    const last = rows[rows.length - 1];
    return { items, nextCursor: r.rows.length > page.limit && last ? Buffer.from(`${last.issued_at.toISOString()}|${last.id}`).toString("base64url") : null };
  }

  private async mine(tx: Queryable, userId: string, organizationId: string, redemptionId: string, lock = false): Promise<RedemptionRow> {
    const member = await memberOf(tx, userId, organizationId);
    const r = await tx.query<RedemptionRow>(
      `select rr.* from togiva.reward_redemptions rr join togiva.loyalty_accounts a on a.id = rr.loyalty_account_id
        where rr.id = $1 and rr.organization_id = $2 and a.organization_customer_id = $3 ${lock ? "for update of rr" : ""}`,
      [redemptionId, organizationId, member.id],
    );
    if (!r.rows[0]) throw new AppError("not_found", "Redemption not found");
    return r.rows[0];
  }

  /** Shows an unused redemption's token again (e.g. the customer reopened the app at the counter). */
  async showMine(tx: Queryable, userId: string, organizationId: string, redemptionId: string): Promise<IssuedRedemption> {
    const red = await this.mine(tx, userId, organizationId, redemptionId);
    if (red.status !== "issued") throw new AppError("redemption_invalid", "This reward has already been used or returned");
    if (red.expires_at <= new Date()) throw new AppError("redemption_expired", "This reward code has expired; the points will be returned");
    return this.issued(red);
  }

  async cancelMine(tx: Queryable, userId: string, organizationId: string, redemptionId: string): Promise<void> {
    const red = await this.mine(tx, userId, organizationId, redemptionId, true);
    if (red.status === "cancelled" || red.status === "expired") return;
    if (red.status !== "issued") throw new AppError("redemption_already_completed", "This reward has already been used");
    await returnPoints(tx, red, "cancelled");
    await tx.query("select togiva.write_audit($1, 'loyalty.redemption_cancelled', 'reward_redemption', $2)", [organizationId, red.id]);
  }

  // ------------------------------------------------------------- staff

  private async byToken(tx: Queryable, organizationId: string, locationId: string, token: string, lock: boolean) {
    const r = await tx.query<RedemptionRow & { reward_name: string; pos_discount_ref: string | null; first_name: string | null; membership_number: string }>(
      `select rr.*, rw.name as reward_name, rw.pos_discount_ref, p.first_name, oc.membership_number
         from togiva.reward_redemptions rr
         join togiva.rewards rw on rw.id = rr.reward_id
         join togiva.loyalty_accounts a on a.id = rr.loyalty_account_id
         join togiva.organization_customers oc on oc.id = a.organization_customer_id
         join togiva.customer_profiles p on p.id = oc.customer_profile_id
        where rr.token_hash = $1 and rr.organization_id = $2 ${lock ? "for update of rr" : ""}`,
      [tokenHash(token), organizationId],
    );
    const red = r.rows[0];
    if (!red) throw new AppError("redemption_invalid", "That reward code is not valid");
    if (red.location_id !== locationId) throw new AppError("redemption_wrong_location", "This reward was issued for a different store");
    const view: RedemptionVerification = {
      id: red.id, status: red.status, reward: { id: red.reward_id, name: red.reward_name, posDiscountRef: red.pos_discount_ref },
      customer: { firstName: red.first_name, membershipLast4: red.membership_number.slice(-4) }, locationId: red.location_id,
      expiresAt: red.expires_at.toISOString(), completedAt: red.completed_at?.toISOString() ?? null,
    };
    return { red, view };
  }

  private static assertUsable(red: RedemptionRow) {
    if (red.status === "completed") throw new AppError("redemption_already_completed", "This reward has already been used");
    if (red.status === "expired" || (red.status === "issued" && red.expires_at <= new Date())) throw new AppError("redemption_expired", "This reward code has expired");
    if (red.status !== "issued") throw new AppError("redemption_invalid", "This reward was cancelled");
  }

  /** Read-only check for the cashier before applying the discount in the POS. */
  async verify(tx: Queryable, organizationId: string, locationId: string, token: string): Promise<RedemptionVerification> {
    const { red, view } = await this.byToken(tx, organizationId, locationId, token, false);
    RedemptionService.assertUsable(red);
    return view;
  }

  /** Marks the reward as handed over. Exactly once: concurrent completions serialize on the row lock. */
  async complete(tx: Queryable, ctx: { userId: string }, organizationId: string, locationId: string, input: { token: string; terminalId?: string }): Promise<RedemptionVerification> {
    const { red, view } = await this.byToken(tx, organizationId, locationId, input.token, true);
    RedemptionService.assertUsable(red);
    const u = await tx.query<{ completed_at: Date }>(
      "update togiva.reward_redemptions set status = 'completed', completed_at = now(), completed_by = $2, terminal_id = $3 where id = $1 returning completed_at",
      [red.id, ctx.userId, input.terminalId ?? null],
    );
    await adjustInventory(tx, red.reward_id, red.location_id, "redeem");
    await tx.query("select togiva.write_audit($1, 'loyalty.redemption_completed', 'reward_redemption', $2, '{}'::jsonb, $3)", [organizationId, red.id, locationId]);
    return { ...view, status: "completed", completedAt: u.rows[0]!.completed_at.toISOString() };
  }
}

/** Job 'loyalty.redemptions.sweep': returns points for tokens that expired unused. */
export const sweepExpiredRedemptions: JobHandler = async (tx) => {
  const r = await tx.query<RedemptionRow>(
    "select * from togiva.reward_redemptions where status = 'issued' and expires_at <= now() order by expires_at limit 500 for update skip locked");
  for (const red of r.rows) await returnPoints(tx, red, "expired");
};
