import type { Queryable } from "@togiva/database";
import { LoyaltyProgramVersionConfig } from "@togiva/shared-types";
import { AppError } from "../../errors.js";
import type { EarningRule, TierDef } from "./engine.js";

export interface Program { id: string; currency: string }
export interface ProgramVersion { id: string; version: number; config: LoyaltyProgramVersionConfig }
export interface Tier extends TierDef { name: string; description: string | null; qualificationMetric: "qualifying_spend" | "qualifying_visits" | "qualifying_points" }
export interface Account { id: string; organizationId: string; organizationCustomerId: string; programId: string; currentTierId: string | null; status: string; openedAt: Date }

export async function activeProgram(tx: Queryable, organizationId: string): Promise<Program | null> {
  const r = await tx.query<{ id: string; currency: string }>(
    "select id, currency from togiva.loyalty_programs where organization_id = $1 and status = 'active'", [organizationId]);
  return r.rows[0] ?? null;
}

/**
 * The version in effect at `at`. Retired versions still count for their
 * effective window, so a sale reported late by the POS earns under the rules
 * that applied when it happened.
 */
export async function versionAt(tx: Queryable, programId: string, at: Date): Promise<ProgramVersion | null> {
  const r = await tx.query<{ id: string; version: number; config: unknown }>(
    `select id, version, config from togiva.loyalty_program_versions
      where loyalty_program_id = $1 and status in ('published', 'retired')
        and (effective_from is null or effective_from <= $2) and (effective_to is null or effective_to > $2)
      order by version desc limit 1`,
    [programId, at],
  );
  const row = r.rows[0];
  return row ? { id: row.id, version: row.version, config: LoyaltyProgramVersionConfig.parse(row.config) } : null;
}

export async function versionById(tx: Queryable, versionId: string): Promise<ProgramVersion> {
  const r = await tx.query<{ id: string; version: number; config: unknown }>("select id, version, config from togiva.loyalty_program_versions where id = $1", [versionId]);
  const row = r.rows[0];
  if (!row) throw new Error(`program version ${versionId} not found`);
  return { id: row.id, version: row.version, config: LoyaltyProgramVersionConfig.parse(row.config) };
}

export async function tiersOf(tx: Queryable, versionId: string): Promise<Tier[]> {
  const r = await tx.query<{ id: string; rank: number; name: string; description: string | null; qualification_metric: Tier["qualificationMetric"]; qualification_threshold: string; earning_multiplier: string }>(
    "select * from togiva.loyalty_tiers where program_version_id = $1 order by rank", [versionId]);
  return r.rows.map((t) => ({
    id: t.id, rank: t.rank, name: t.name, description: t.description, qualificationMetric: t.qualification_metric,
    qualificationThreshold: Number(t.qualification_threshold), earningMultiplier: Number(t.earning_multiplier),
  }));
}

export async function rulesOf(tx: Queryable, versionId: string): Promise<EarningRule[]> {
  const r = await tx.query<{ id: string; rule_type: EarningRule["ruleType"]; name: string; priority: number; points_per_unit: string | null; multiplier: string | null; bonus_points: string | null; conditions: unknown; starts_at: Date | null; ends_at: Date | null; status: EarningRule["status"] }>(
    "select * from togiva.loyalty_earning_rules where program_version_id = $1", [versionId]);
  const num = (v: string | null) => (v === null ? null : Number(v));
  return r.rows.map((x) => ({
    id: x.id, ruleType: x.rule_type, name: x.name, priority: x.priority, pointsPerUnit: num(x.points_per_unit), multiplier: num(x.multiplier),
    bonusPoints: num(x.bonus_points), conditions: x.conditions, startsAt: x.starts_at, endsAt: x.ends_at, status: x.status,
  }));
}

const toAccount = (a: { id: string; organization_id: string; organization_customer_id: string; loyalty_program_id: string; current_tier_id: string | null; status: string; opened_at: Date }): Account => ({
  id: a.id, organizationId: a.organization_id, organizationCustomerId: a.organization_customer_id, programId: a.loyalty_program_id,
  currentTierId: a.current_tier_id, status: a.status, openedAt: a.opened_at,
});

export async function findAccount(tx: Queryable, organizationCustomerId: string, programId: string): Promise<Account | null> {
  const r = await tx.query("select * from togiva.loyalty_accounts where organization_customer_id = $1 and loyalty_program_id = $2", [organizationCustomerId, programId]);
  return r.rows[0] ? toAccount(r.rows[0]) : null;
}

/** Service role only. Opens the member's account on first use and locks it for this transaction. */
export async function lockAccount(tx: Queryable, organizationId: string, organizationCustomerId: string, programId: string): Promise<Account> {
  await tx.query(
    `insert into togiva.loyalty_accounts (organization_id, organization_customer_id, loyalty_program_id) values ($1, $2, $3)
     on conflict (organization_customer_id, loyalty_program_id) do nothing`,
    [organizationId, organizationCustomerId, programId],
  );
  const r = await tx.query("select * from togiva.loyalty_accounts where organization_customer_id = $1 and loyalty_program_id = $2 for update", [organizationCustomerId, programId]);
  return toAccount(r.rows[0]);
}

export async function tierRankOf(tx: Queryable, tierId: string | null): Promise<number | null> {
  if (!tierId) return null;
  const r = await tx.query<{ rank: number }>("select rank from togiva.loyalty_tiers where id = $1", [tierId]);
  return r.rows[0]?.rank ?? null;
}

export interface Progress { amountMinor: number; visits: number; points: number }

export async function progressBetween(tx: Queryable, accountId: string, start: Date, end: Date | null): Promise<Progress> {
  const r = await tx.query<{ amount: string; visits: string; points: string }>(
    `select coalesce(sum(qualifying_amount_minor), 0) as amount, coalesce(sum(qualifying_visits), 0) as visits,
            coalesce(sum(points) filter (where entry_type in ('earn', 'bonus', 'refund_reversal', 'void_reversal')), 0) as points
       from togiva.loyalty_ledger where loyalty_account_id = $1 and occurred_at >= $2 and ($3::timestamptz is null or occurred_at < $3)`,
    [accountId, start, end],
  );
  const row = r.rows[0]!;
  return { amountMinor: Number(row.amount), visits: Number(row.visits), points: Number(row.points) };
}

export const progressFor = (metric: Tier["qualificationMetric"], p: Progress) =>
  metric === "qualifying_spend" ? p.amountMinor : metric === "qualifying_visits" ? p.visits : p.points;

export interface Balance { available: number; pending: number; lifetimeEarned: number; lifetimeRedeemed: number }

export async function balanceOf(tx: Queryable, accountId: string): Promise<Balance> {
  const r = await tx.query<{ available_points: string; pending_points: string; lifetime_earned_points: string; lifetime_redeemed_points: string }>(
    "select * from togiva.loyalty_ledger_balance($1)", [accountId]);
  const b = r.rows[0]!;
  return { available: Number(b.available_points), pending: Number(b.pending_points), lifetimeEarned: Number(b.lifetime_earned_points), lifetimeRedeemed: Number(b.lifetime_redeemed_points) };
}

/** Resolves the caller's active membership in the organization (service role, explicit scoping). */
export async function memberOf(tx: Queryable, userId: string, organizationId: string): Promise<{ id: string; membershipNumber: string; firstName: string | null }> {
  const r = await tx.query<{ id: string; membership_number: string; first_name: string | null }>(
    `select oc.id, oc.membership_number, p.first_name from togiva.organization_customers oc
       join togiva.customer_profiles p on p.id = oc.customer_profile_id
      where oc.organization_id = $1 and p.user_id = $2 and oc.status = 'active'`,
    [organizationId, userId],
  );
  const row = r.rows[0];
  if (!row) throw new AppError("membership_required", "Join the membership program first");
  return { id: row.id, membershipNumber: row.membership_number, firstName: row.first_name };
}

export async function requireActiveProgram(tx: Queryable, organizationId: string): Promise<Program> {
  const p = await activeProgram(tx, organizationId);
  if (!p) throw new AppError("loyalty_program_unavailable", "The rewards program is not available yet");
  return p;
}
