import type { Queryable } from "@togiva/database";
import type { ActivityItem, RewardSummary, Wallet } from "@togiva/shared-types";
import { AppError } from "../../errors.js";
import { nextTierAfter, qualificationWindow } from "./engine.js";
import { balanceOf, findAccount, memberOf, progressBetween, progressFor, requireActiveProgram, tierRankOf, tiersOf, versionAt, type Account, type Tier } from "./program.js";

/*
 * Customer-facing loyalty reads. They run as the service role with explicit
 * scoping: every query is bound to the caller's own membership, resolved from
 * the verified user id by memberOf(). Nothing here trusts a client-supplied
 * customer id.
 */

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

const tierSummary = (t: Tier) => ({
  id: t.id, rank: t.rank, name: t.name, description: t.description, qualificationMetric: t.qualificationMetric, qualificationThreshold: t.qualificationThreshold,
});

export async function getWallet(tx: Queryable, userId: string, organizationId: string, now = new Date()): Promise<Wallet> {
  const member = await memberOf(tx, userId, organizationId);
  const program = await requireActiveProgram(tx, organizationId);
  const version = await versionAt(tx, program.id, now);
  if (!version) throw new AppError("loyalty_program_unavailable", "The rewards program is not available yet");
  const account = await findAccount(tx, member.id, program.id);
  const tiers = await tiersOf(tx, version.id);
  const balance = account ? await balanceOf(tx, account.id) : { available: 0, pending: 0, lifetimeEarned: 0, lifetimeRedeemed: 0 };

  const window = qualificationWindow(version.config.qualification.period, now, account?.openedAt ?? now);
  const progress = account ? progressFor(version.config.qualification.metric, await progressBetween(tx, account.id, window.start, window.end)) : 0;
  const rank = account ? await tierRankOf(tx, account.currentTierId) : null;
  const current = rank === null ? null : tiers.find((t) => t.rank === rank) ?? null;
  const next = nextTierAfter(tiers, current);

  const available = Math.max(0, balance.available);
  const nr = await tx.query<{ id: string; name: string; points_cost: string }>(
    `select id, name, points_cost from togiva.rewards
      where loyalty_program_id = $1 and status = 'active' and not is_surprise and points_cost > $2
        and (available_from is null or available_from <= now()) and (available_until is null or available_until > now())
      order by points_cost, id limit 1`,
    [program.id, available],
  );
  const nextReward = nr.rows[0] ? { rewardId: nr.rows[0].id, name: nr.rows[0].name, pointsCost: Number(nr.rows[0].points_cost), pointsNeeded: Number(nr.rows[0].points_cost) - available } : null;

  // Purchases the store has submitted that the POS has not confirmed yet, or
  // that are confirmed but still queued for the loyalty engine.
  const pending = await tx.query(
    `select 1 from togiva.customer_transaction_associations a
      where a.organization_customer_id = $1 and (a.status = 'pending_pos_confirmation'
        or (a.status = 'confirmed' and exists (select 1 from togiva.background_jobs j where j.job_type = 'loyalty.process_association'
              and j.status in ('pending', 'running', 'failed') and j.payload->>'associationId' = a.id::text)))
      limit 1`,
    [member.id],
  );

  return {
    organizationCustomerId: member.id,
    membershipNumber: member.membershipNumber,
    availablePoints: available,
    pendingPoints: Math.max(0, balance.pending),
    currentTier: current ? tierSummary(current) : null,
    nextTier: next ? tierSummary(next) : null,
    qualification: {
      metric: version.config.qualification.metric,
      periodStart: isoDate(window.start),
      periodEnd: window.end ? isoDate(new Date(window.end.getTime() - 86_400_000)) : null,
      progress: Math.max(0, progress),
      nextThreshold: next?.qualificationThreshold ?? null,
    },
    nextReward,
    dataStatus: pending.rowCount ? "pending_updates" : "current",
  };
}

const decodeCursor = (c?: string) => (c ? Buffer.from(c, "base64url").toString().split("|") : null);
const encodeCursor = (...parts: string[]) => Buffer.from(parts.join("|")).toString("base64url");

/** Activity feed: ledger entries (a purchase's earn and bonus rows merged) plus purchases awaiting POS confirmation. */
export async function listActivity(tx: Queryable, userId: string, organizationId: string, page: { cursor?: string; limit: number }, now = new Date()) {
  const member = await memberOf(tx, userId, organizationId);
  const program = await requireActiveProgram(tx, organizationId);
  const account = await findAccount(tx, member.id, program.id);
  const cur = decodeCursor(page.cursor);
  const r = await tx.query<{
    id: string; kind: ActivityItem["kind"]; occurred_at: Date; location_id: string | null; location_name: string | null;
    eligible_minor: string | null; currency: string | null; points: string; bonus_points: string; reward_name: string | null; entry_type: string | null;
  }>(
    `with entries as (
       -- one row per purchase: base + bonus merged
       select 'txn:' || l.source_id as id,
              case when max(coalesce(l.available_at, l.occurred_at)) > $3 then 'purchase_pending' else 'purchase_earned' end as kind,
              min(l.occurred_at) as occurred_at, min(l.location_id::text)::uuid as location_id,
              max((l.metadata->>'eligibleMinor')::bigint) as eligible_minor, min(l.currency) as currency,
              coalesce(sum(l.points) filter (where l.entry_type = 'earn'), 0) as points,
              coalesce(sum(l.points) filter (where l.entry_type = 'bonus'), 0) as bonus_points,
              null::text as reward_name, null::text as entry_type
         from togiva.loyalty_ledger l
        where l.loyalty_account_id = $1 and l.entry_type in ('earn', 'bonus')
        group by l.source_id
       union all
       select 'ledger:' || l.id, case l.entry_type when 'redeem' then 'redemption' when 'adjustment' then 'adjustment'
                                   when 'expiration' then 'expiration' else 'reversal' end,
              l.occurred_at, l.location_id, null, l.currency, l.points, 0, rw.name, l.entry_type
         from togiva.loyalty_ledger l
         left join togiva.reward_redemptions rr on l.source_type = 'reward_redemption' and rr.id::text = l.source_id
         left join togiva.rewards rw on rw.id = rr.reward_id
        where l.loyalty_account_id = $1 and l.entry_type not in ('earn', 'bonus')
       union all
       select 'assoc:' || a.id, 'purchase_pending', a.created_at, a.location_id, null, null, 0, 0, null, null
         from togiva.customer_transaction_associations a
        where a.organization_customer_id = $2 and a.status = 'pending_pos_confirmation'
     )
     select e.*, loc.name as location_name from entries e left join togiva.locations loc on loc.id = e.location_id
      where ($4::timestamptz is null or (e.occurred_at, e.id) < ($4, $5))
      order by e.occurred_at desc, e.id desc limit $6`,
    [account?.id ?? null, member.id, now, cur?.[0] ?? null, cur?.[1] ?? null, page.limit + 1],
  );
  const rows = r.rows.slice(0, page.limit);
  const describe = (row: (typeof rows)[number]): string => {
    switch (row.kind) {
      case "purchase_pending": return row.id.startsWith("assoc:") ? "Purchase waiting for the store's register to confirm" : "Purchase points pending";
      case "purchase_earned": return "Purchase";
      case "redemption": return row.reward_name ? `Redeemed ${row.reward_name}` : "Reward redeemed";
      case "adjustment": return "Points adjustment";
      case "expiration": return "Points expired";
      default:
        return row.entry_type === "redeem_reversal" ? (row.reward_name ? `${row.reward_name} not used, points returned` : "Reward points returned")
          : row.entry_type === "void_reversal" ? "Purchase voided" : "Purchase refunded";
    }
  };
  const items: ActivityItem[] = rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    occurredAt: row.occurred_at.toISOString(),
    location: row.location_id && row.location_name ? { id: row.location_id, name: row.location_name } : null,
    eligibleAmount: row.eligible_minor !== null && row.currency ? { amountMinor: Number(row.eligible_minor), currency: row.currency } : null,
    points: Number(row.points),
    bonusPoints: Number(row.bonus_points),
    description: describe(row),
  }));
  const last = rows[rows.length - 1];
  return { items, nextCursor: r.rows.length > page.limit && last ? encodeCursor(last.occurred_at.toISOString(), last.id) : null };
}

// ---------------------------------------------------------------- rewards

export interface RewardRow {
  id: string; name: string; description: string | null; category: RewardSummary["category"]; points_cost: string; image_ref: string | null;
  available_from: Date | null; available_until: Date | null; min_tier_rank: number | null; all_participating_locations: boolean;
  per_customer_limit: number | null; per_customer_limit_period: "day" | "week" | "month" | "year" | "lifetime" | null;
  redemption_ttl_seconds: number; status: string; loyalty_program_id: string; organization_id: string; pos_discount_ref: string | null;
  location_ids: string[] | null;
}

export const REWARD_SELECT = `select r.*, case when r.all_participating_locations then null
    else coalesce((select array_agg(e.location_id order by e.location_id) from togiva.reward_location_eligibility e where e.reward_id = r.id), '{}') end as location_ids
  from togiva.rewards r`;

type Reason = NonNullable<RewardSummary["eligibility"]>["reasons"][number];

/** Per-customer eligibility, evaluated entirely server-side. */
export async function rewardEligibility(tx: Queryable, reward: RewardRow, ctx: { account: Account | null; available: number; tierRank: number | null; locationId?: string }, now = new Date()): Promise<Reason[]> {
  const reasons: Reason[] = [];
  if (reward.available_from && reward.available_from > now) reasons.push("not_yet_available");
  if (reward.available_until && reward.available_until <= now) reasons.push("expired");
  if (reward.min_tier_rank !== null && (ctx.tierRank === null || ctx.tierRank < reward.min_tier_rank)) reasons.push("tier_required");
  if (ctx.locationId && reward.location_ids && !reward.location_ids.includes(ctx.locationId)) reasons.push("not_available_at_location");
  if (ctx.available < Number(reward.points_cost)) reasons.push("insufficient_points");
  if (reward.per_customer_limit !== null && ctx.account) {
    const since = reward.per_customer_limit_period === "lifetime" || !reward.per_customer_limit_period ? null
      : `1 ${reward.per_customer_limit_period}`;
    const used = await tx.query<{ n: number }>(
      `select count(*)::int as n from togiva.reward_redemptions where loyalty_account_id = $1 and reward_id = $2 and status in ('issued', 'completed')
         and ($3::interval is null or issued_at > now() - $3::interval)`,
      [ctx.account.id, reward.id, since],
    );
    if (used.rows[0]!.n >= reward.per_customer_limit) reasons.push("limit_reached");
  }
  const stock = await tx.query<{ left: number }>(
    `select (quantity_total - quantity_reserved - quantity_redeemed)::int as left from togiva.reward_inventory
      where reward_id = $1 and (location_id is null or location_id = $2) order by location_id nulls last`,
    [reward.id, ctx.locationId ?? null],
  );
  if (stock.rows.some((s) => s.left <= 0)) reasons.push("out_of_stock");
  return reasons;
}

export const rewardSummary = (r: RewardRow, reasons: Reason[] | null): RewardSummary => ({
  id: r.id, name: r.name, description: r.description, category: r.category, pointsCost: Number(r.points_cost), imageRef: r.image_ref,
  availableFrom: iso(r.available_from), availableUntil: iso(r.available_until), minTierRank: r.min_tier_rank, locationIds: r.location_ids,
  eligibility: reasons ? { eligible: reasons.length === 0, reasons } : null,
});

export async function listRewards(tx: Queryable, userId: string, organizationId: string, page: { cursor?: string; limit: number; locationId?: string }) {
  const member = await memberOf(tx, userId, organizationId);
  const program = await requireActiveProgram(tx, organizationId);
  const account = await findAccount(tx, member.id, program.id);
  const available = account ? Math.max(0, (await balanceOf(tx, account.id)).available) : 0;
  const tierRank = account ? await tierRankOf(tx, account.currentTierId) : null;
  const cur = decodeCursor(page.cursor);
  const r = await tx.query<RewardRow>(
    `${REWARD_SELECT}
      where r.loyalty_program_id = $1 and r.status = 'active' and not r.is_surprise
        and (r.available_until is null or r.available_until > now())
        and ($2::bigint is null or (r.points_cost, r.id) > ($2, $3::uuid))
      order by r.points_cost, r.id limit $4`,
    [program.id, cur?.[0] ?? null, cur?.[1] ?? null, page.limit + 1],
  );
  const rows = r.rows.slice(0, page.limit);
  const items = [];
  for (const row of rows) items.push(rewardSummary(row, await rewardEligibility(tx, row, { account, available, tierRank, locationId: page.locationId })));
  const last = rows[rows.length - 1];
  return { items, nextCursor: r.rows.length > page.limit && last ? encodeCursor(last.points_cost, last.id) : null };
}
