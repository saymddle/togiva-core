import type { Queryable } from "@togiva/database";
import { RetryLater, type JobHandler } from "../jobs/queue.js";
import { evaluateEarning, qualificationWindow, tierForProgress, type EarningMember, type EarningResult, type EarningTransaction } from "./engine.js";
import { activeProgram, lockAccount, progressBetween, progressFor, rulesOf, tierRankOf, tiersOf, versionAt, versionById, type Account, type ProgramVersion } from "./program.js";

/** Snapshot stored on the earn entry so refunds are recomputed under the same terms. */
interface EarnSnapshot {
  associationId: string;
  tierRank: number | null;
  tierMultiplier: number;
  priorVisitsInPeriod: number;
  eligibleMinor: number;
  currency: string;
  lines: { ruleId: string; name: string; points: number }[];
}

async function loadTransaction(tx: Queryable, posTransactionId: string): Promise<(EarningTransaction & { id: string; organizationId: string; status: string }) | null> {
  const t = await tx.query<{
    id: string; organization_id: string; location_id: string; currency: string; subtotal_minor: string; discount_minor: string; tax_minor: string;
    tip_minor: string; service_charge_minor: string; fee_minor: string; total_minor: string; refunded_minor: string; status: string; purchased_at: Date; timezone: string;
  }>(
    `select t.*, l.timezone from togiva.pos_transactions t join togiva.locations l on l.id = t.location_id where t.id = $1`,
    [posTransactionId],
  );
  const row = t.rows[0];
  if (!row) return null;
  const items = await tx.query<{ external_product_ref: string | null; category: string | null; quantity: string; total_minor: string }>(
    "select external_product_ref, category, quantity, total_minor from togiva.pos_transaction_items where pos_transaction_id = $1", [row.id]);
  const regions = await tx.query<{ region_id: string }>("select region_id from togiva.location_regions where location_id = $1", [row.location_id]);
  const n = Number;
  return {
    id: row.id, organizationId: row.organization_id, status: row.status,
    currency: row.currency, subtotalMinor: n(row.subtotal_minor), discountMinor: n(row.discount_minor), taxMinor: n(row.tax_minor), tipMinor: n(row.tip_minor),
    serviceChargeMinor: n(row.service_charge_minor), feeMinor: n(row.fee_minor), totalMinor: n(row.total_minor), refundedMinor: n(row.refunded_minor),
    voided: row.status === "voided", purchasedAt: row.purchased_at, locationId: row.location_id, timezone: row.timezone,
    regionIds: regions.rows.map((r) => r.region_id),
    items: items.rows.map((i) => ({ productRef: i.external_product_ref, category: i.category, quantity: n(i.quantity), totalMinor: n(i.total_minor) })),
  };
}

const addMonths = (d: Date, months: number) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + months); return x; };

interface LedgerInsert {
  account: Account; entryType: string; points: number; qualifyingAmountMinor?: number; qualifyingVisits?: number; currency?: string | null;
  sourceType: string; sourceId: string; locationId?: string | null; versionId?: string | null; ruleIds?: string[]; reversesEntryId?: string | null;
  idempotencyKey: string; occurredAt: Date; availableAt?: Date | null; expiresAt?: Date | null; recordedBy?: string | null; metadata?: unknown;
}

/** Appends one ledger row. Returns its id, or null if the idempotency key was already used. */
export async function appendLedger(tx: Queryable, e: LedgerInsert): Promise<string | null> {
  const r = await tx.query<{ id: string }>(
    `insert into togiva.loyalty_ledger (organization_id, loyalty_account_id, entry_type, points, qualifying_amount_minor, qualifying_visits, currency,
       source_type, source_id, location_id, program_version_id, earning_rule_ids, reverses_entry_id, idempotency_key, occurred_at, available_at,
       points_expire_at, recorded_by, metadata)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
     on conflict (organization_id, idempotency_key) do nothing returning id`,
    [e.account.organizationId, e.account.id, e.entryType, e.points, e.qualifyingAmountMinor ?? 0, e.qualifyingVisits ?? 0, e.currency ?? null,
      e.sourceType, e.sourceId, e.locationId ?? null, e.versionId ?? null, e.ruleIds ?? [], e.reversesEntryId ?? null, e.idempotencyKey,
      e.occurredAt, e.availableAt ?? null, e.expiresAt ?? null, e.recordedBy ?? null, JSON.stringify(e.metadata ?? {})],
  );
  return r.rows[0]?.id ?? null;
}

async function integrationError(tx: Queryable, organizationId: string, locationId: string | null, code: string, message: string, details: unknown) {
  await tx.query(
    "insert into togiva.integration_errors (organization_id, location_id, source, error_code, message, details) values ($1, $2, 'loyalty', $3, $4, $5)",
    [organizationId, locationId, code, message, JSON.stringify(details)],
  );
}

/**
 * Promotes the member when qualification progress reaches a higher tier.
 * Tiers are never lowered here: when (and whether) a tier lapses is an
 * organization policy that is not configurable yet.
 */
export async function evaluateTier(tx: Queryable, account: Account, version: ProgramVersion, now = new Date()): Promise<void> {
  const tiers = await tiersOf(tx, version.id);
  if (tiers.length === 0) return;
  const window = qualificationWindow(version.config.qualification.period, now, account.openedAt);
  const progress = progressFor(version.config.qualification.metric, await progressBetween(tx, account.id, window.start, window.end));
  const reached = tierForProgress(tiers, progress);
  const currentRank = await tierRankOf(tx, account.currentTierId);
  if (reached && (currentRank === null || reached.rank > currentRank)) {
    await tx.query("update togiva.loyalty_accounts set current_tier_id = $2 where id = $1", [account.id, reached.id]);
    await tx.query("select togiva.write_audit($1, 'loyalty.tier_achieved', 'loyalty_account', $2, $3)",
      [account.organizationId, account.id, JSON.stringify({ tierId: reached.id, rank: reached.rank, progress })]);
  }
}

async function memberTerms(tx: Queryable, account: Account, version: ProgramVersion, at: Date): Promise<EarningMember> {
  const storedRank = await tierRankOf(tx, account.currentTierId);
  const tiers = await tiersOf(tx, version.id);
  const window = qualificationWindow(version.config.qualification.period, at, account.openedAt);
  const prior = await progressBetween(tx, account.id, window.start, window.end);
  // Same rule as the wallet: the stored tier, or the tier prior progress already reaches (e.g. a threshold-0 tier), whichever is higher.
  const reached = tierForProgress(tiers, Math.max(0, progressFor(version.config.qualification.metric, prior)));
  const rank = Math.max(storedRank ?? 0, reached?.rank ?? 0) || null;
  const tier = rank === null ? undefined : tiers.find((t) => t.rank === rank);
  return { tierRank: rank, tierMultiplier: tier?.earningMultiplier ?? 1, priorVisitsInPeriod: prior.visits };
}

/**
 * Awards points for a purchase once the POS has confirmed it
 * (job 'loyalty.process_association', enqueued by association reconciliation).
 * Idempotent per POS transaction: the ledger's idempotency keys make a retry
 * or a duplicate job a no-op.
 */
export const processAssociation: JobHandler = async (tx, job) => {
  const { associationId } = job.payload as { associationId: string };
  const a = await tx.query<{ id: string; organization_id: string; organization_customer_id: string; status: string; pos_transaction_id: string | null; location_id: string }>(
    "select id, organization_id, organization_customer_id, status, pos_transaction_id, location_id from togiva.customer_transaction_associations where id = $1", [associationId]);
  const assoc = a.rows[0];
  if (!assoc || assoc.status !== "confirmed" || !assoc.pos_transaction_id) return;

  const txn = await loadTransaction(tx, assoc.pos_transaction_id);
  if (!txn) return;
  const program = await activeProgram(tx, assoc.organization_id);
  if (!program) {
    await integrationError(tx, assoc.organization_id, assoc.location_id, "loyalty_program_not_configured",
      "A member purchase was confirmed but the organization has no active loyalty program", { associationId });
    return;
  }
  const version = await versionAt(tx, program.id, txn.purchasedAt);
  if (!version) {
    await integrationError(tx, assoc.organization_id, assoc.location_id, "loyalty_version_not_effective",
      "No published loyalty program version was in effect at the time of purchase", { associationId, purchasedAt: txn.purchasedAt });
    return;
  }
  if (txn.currency !== program.currency) {
    await integrationError(tx, assoc.organization_id, assoc.location_id, "loyalty_currency_mismatch",
      "The sale's currency differs from the loyalty program's currency", { associationId, saleCurrency: txn.currency, programCurrency: program.currency });
    return;
  }

  const account = await lockAccount(tx, assoc.organization_id, assoc.organization_customer_id, program.id);
  const existing = await tx.query("select 1 from togiva.loyalty_ledger where loyalty_account_id = $1 and source_type = 'pos_transaction' and source_id = $2 limit 1", [account.id, txn.id]);
  if (existing.rowCount) return;
  if (account.status !== "active") {
    await tx.query("select togiva.write_audit($1, 'loyalty.earning_skipped', 'loyalty_account', $2, $3)",
      [account.organizationId, account.id, JSON.stringify({ reason: `account_${account.status}`, posTransactionId: txn.id })]);
    return;
  }

  const member = await memberTerms(tx, account, version, txn.purchasedAt);
  const result = evaluateEarning({ config: version.config, rules: await rulesOf(tx, version.id), txn, member });
  await recordEarning(tx, account, version, txn, member, result, associationId);
  await tx.query("select togiva.refresh_loyalty_projection($1)", [account.id]);
  await evaluateTier(tx, account, version);
};

async function recordEarning(tx: Queryable, account: Account, version: ProgramVersion, txn: EarningTransaction & { id: string }, member: EarningMember, result: EarningResult, associationId: string) {
  const snapshot: EarnSnapshot = {
    associationId, tierRank: member.tierRank, tierMultiplier: member.tierMultiplier, priorVisitsInPeriod: member.priorVisitsInPeriod,
    eligibleMinor: result.eligibleMinor, currency: txn.currency,
    lines: [...(result.base ? [result.base] : []), ...result.bonuses].map((l) => ({ ruleId: l.ruleId, name: l.name, points: l.points })),
  };
  const availableAt = new Date(txn.purchasedAt.getTime() + version.config.pendingPeriodSeconds * 1000);
  const expiresAt = version.config.pointsExpireAfterMonths ? addMonths(txn.purchasedAt, version.config.pointsExpireAfterMonths) : null;
  const common = { account, currency: txn.currency, sourceType: "pos_transaction", sourceId: txn.id, locationId: txn.locationId, versionId: version.id, occurredAt: txn.purchasedAt, availableAt, expiresAt };
  // Qualifying spend and the visit ride on the first entry written.
  let qualifying = { qualifyingAmountMinor: result.eligibleMinor, qualifyingVisits: result.qualifyingVisits };
  if (result.basePoints > 0) {
    await appendLedger(tx, { ...common, entryType: "earn", points: result.basePoints, ...qualifying, ruleIds: result.base ? [result.base.ruleId] : [], idempotencyKey: `earn:${txn.id}`, metadata: snapshot });
    qualifying = { qualifyingAmountMinor: 0, qualifyingVisits: 0 };
  }
  if (result.bonusPoints > 0) {
    await appendLedger(tx, { ...common, entryType: "bonus", points: result.bonusPoints, ...qualifying, ruleIds: result.bonuses.map((b) => b.ruleId), idempotencyKey: `bonus:${txn.id}`, metadata: snapshot });
  }
  if (result.basePoints <= 0 && result.bonusPoints <= 0) {
    await tx.query("select togiva.write_audit($1, 'loyalty.purchase_earned_nothing', 'pos_transaction', $2, $3)",
      [account.organizationId, txn.id, JSON.stringify({ eligibleMinor: result.eligibleMinor, associationId })]);
  }
}

/**
 * Recomputes a credited sale after the POS reports a refund or void, and
 * appends a compensating entry for the difference. The original entries are
 * never touched. Uses the program version and member terms captured when the
 * points were earned, so a later rule change cannot alter a reversal.
 */
export const processTransactionChange: JobHandler = async (tx, job) => {
  const { posTransactionId } = job.payload as { posTransactionId: string };
  const txn = await loadTransaction(tx, posTransactionId);
  if (!txn) return;
  const credits = await tx.query<{ id: string; loyalty_account_id: string; entry_type: string; points: string; qualifying_amount_minor: string; qualifying_visits: number; program_version_id: string | null; available_at: Date | null; occurred_at: Date; metadata: EarnSnapshot }>(
    "select * from togiva.loyalty_ledger where organization_id = $1 and source_type = 'pos_transaction' and source_id = $2 order by id",
    [txn.organizationId, txn.id],
  );
  const original = credits.rows.find((c) => c.entry_type === "earn" || c.entry_type === "bonus");
  if (!original) {
    // Points not awarded yet: wait for the earning job, which evaluates the sale in its current (refunded) state.
    const pending = await tx.query(
      `select 1 from togiva.background_jobs j join togiva.customer_transaction_associations a on a.id = (j.payload->>'associationId')::uuid
        where j.job_type = 'loyalty.process_association' and j.status in ('pending', 'running', 'failed') and a.pos_transaction_id = $1 limit 1`,
      [txn.id],
    );
    if (pending.rowCount) throw new RetryLater("earning not processed yet");
    return;
  }
  const accountRow = await tx.query("select * from togiva.loyalty_accounts where id = $1 for update", [original.loyalty_account_id]);
  const a = accountRow.rows[0];
  const account: Account = { id: a.id, organizationId: a.organization_id, organizationCustomerId: a.organization_customer_id, programId: a.loyalty_program_id, currentTierId: a.current_tier_id, status: a.status, openedAt: a.opened_at };
  const version = await versionById(tx, original.program_version_id!);
  const snap = original.metadata;
  const member: EarningMember = { tierRank: snap.tierRank, tierMultiplier: snap.tierMultiplier, priorVisitsInPeriod: snap.priorVisitsInPeriod };
  const target = evaluateEarning({ config: version.config, rules: await rulesOf(tx, version.id), txn, member });
  const targetPoints = target.basePoints + target.bonusPoints;
  const targetVisits = target.eligibleMinor > 0 ? 1 : 0;

  const sum = (f: (c: (typeof credits.rows)[number]) => number) => credits.rows.reduce((n, c) => n + f(c), 0);
  const credited = sum((c) => Number(c.points));
  const delta = targetPoints - credited;
  if (delta >= 0) return; // nothing to take back; refunds never add points
  const futureAvailability = original.available_at && original.available_at > new Date() ? original.available_at : null;
  await appendLedger(tx, {
    account, entryType: txn.voided ? "void_reversal" : "refund_reversal", points: delta,
    qualifyingAmountMinor: target.eligibleMinor - sum((c) => Number(c.qualifying_amount_minor)),
    qualifyingVisits: targetVisits - sum((c) => c.qualifying_visits),
    currency: txn.currency, sourceType: "pos_transaction", sourceId: txn.id, locationId: txn.locationId, versionId: version.id,
    reversesEntryId: original.id, idempotencyKey: `reversal:${txn.id}:${txn.status}:${txn.refundedMinor}`,
    occurredAt: new Date(), availableAt: futureAvailability,
    metadata: { posStatus: txn.status, refundedMinor: txn.refundedMinor, targetPoints, previouslyCredited: credited },
  });
  await tx.query("select togiva.refresh_loyalty_projection($1)", [account.id]);
};
