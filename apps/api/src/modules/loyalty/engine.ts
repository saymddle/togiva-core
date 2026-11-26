import { EarningRuleConditions, type LoyaltyProgramVersionConfig } from "@togiva/shared-types";

/**
 * Pure earning evaluation. No I/O: the caller loads the program version, its
 * rules, the member's tier and the normalized POS transaction, and records the
 * result in the ledger. Every number here comes from organization
 * configuration; the engine has no business defaults of its own.
 */

export type RuleType = "base_rate" | "multiplier" | "fixed_bonus" | "spend_threshold_bonus" | "product_bonus" | "visit_bonus";

export interface EarningRule {
  id: string;
  ruleType: RuleType;
  name: string;
  priority: number;
  pointsPerUnit: number | null;
  multiplier: number | null;
  bonusPoints: number | null;
  conditions: unknown;
  startsAt: Date | null;
  endsAt: Date | null;
  status: "active" | "disabled";
}

export interface TransactionItem {
  productRef: string | null;
  category: string | null;
  quantity: number;
  totalMinor: number;
}

export interface EarningTransaction {
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  tipMinor: number;
  serviceChargeMinor: number;
  feeMinor: number;
  totalMinor: number;
  refundedMinor: number;
  voided: boolean;
  purchasedAt: Date;
  locationId: string;
  regionIds: string[];
  /** IANA zone of the location, for day-of-week rules. */
  timezone: string;
  items: TransactionItem[];
}

export interface EarningMember {
  tierRank: number | null;
  /** Tier earning multiplier applied to base points; 1 when the member has no tier. */
  tierMultiplier: number;
  /** Qualifying visits already recorded in the current period, before this one. */
  priorVisitsInPeriod: number;
}

export interface EarningLine {
  ruleId: string;
  ruleType: RuleType;
  name: string;
  points: number;
}

export interface EarningResult {
  /** Eligible spend after exclusions and refunds, in minor units. */
  eligibleMinor: number;
  basePoints: number;
  bonusPoints: number;
  base: EarningLine | null;
  bonuses: EarningLine[];
  /** 1 when this purchase counts as a qualifying visit, else 0. */
  qualifyingVisits: number;
  ruleIds: string[];
}

const EMPTY = (eligibleMinor = 0): EarningResult => ({ eligibleMinor, basePoints: 0, bonusPoints: 0, base: null, bonuses: [], qualifyingVisits: 0, ruleIds: [] });

/** Number of minor units in one major unit for an ISO-4217 currency (USD -> 100, JPY -> 1). */
export function minorPerMajor(currency: string): number {
  const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  return 10 ** digits;
}

function round(value: number, mode: LoyaltyProgramVersionConfig["rounding"]): number {
  // Guard against binary float noise (e.g. 2.9999999996) before rounding.
  const v = Math.round(value * 1e6) / 1e6;
  return mode === "floor" ? Math.floor(v) : mode === "ceil" ? Math.ceil(v) : Math.round(v);
}

function itemExcluded(item: TransactionItem, config: LoyaltyProgramVersionConfig): boolean {
  const { excludeProductRefs, excludeCategories } = config.eligibleAmount;
  return (item.productRef !== null && excludeProductRefs.includes(item.productRef)) || (item.category !== null && excludeCategories.includes(item.category));
}

/**
 * Eligible spend: the configured components of the sale, minus excluded
 * items, reduced proportionally by any refunded amount. Never negative.
 */
export function eligibleAmountMinor(txn: EarningTransaction, config: LoyaltyProgramVersionConfig): number {
  if (txn.voided) return 0;
  const inc = new Set(config.eligibleAmount.include);
  let amount = 0;
  if (inc.has("subtotal")) amount += txn.subtotalMinor;
  if (inc.has("discount")) amount -= txn.discountMinor;
  if (inc.has("tax")) amount += txn.taxMinor;
  if (inc.has("tip")) amount += txn.tipMinor;
  if (inc.has("service_charge")) amount += txn.serviceChargeMinor;
  if (inc.has("fee")) amount += txn.feeMinor;
  if (inc.has("subtotal")) {
    for (const item of txn.items) if (itemExcluded(item, config)) amount -= item.totalMinor;
  }
  amount = Math.max(0, amount);
  if (txn.refundedMinor > 0 && txn.totalMinor > 0) {
    const kept = Math.max(0, txn.totalMinor - txn.refundedMinor) / txn.totalMinor;
    amount = Math.floor(amount * kept);
  }
  return amount;
}

function dayOfWeek(at: Date, timezone: string): number {
  const name = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: timezone }).format(at);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
}

function matchingItems(c: EarningRuleConditions, txn: EarningTransaction, config: LoyaltyProgramVersionConfig): TransactionItem[] {
  return txn.items.filter((i) => !itemExcluded(i, config)
    && (!c.productRefs || (i.productRef !== null && c.productRefs.includes(i.productRef)))
    && (!c.categories || (i.category !== null && c.categories.includes(i.category))));
}

function applies(rule: EarningRule, c: EarningRuleConditions, txn: EarningTransaction, member: EarningMember, eligibleMinor: number): boolean {
  if (rule.status !== "active") return false;
  if (rule.startsAt && txn.purchasedAt < rule.startsAt) return false;
  if (rule.endsAt && txn.purchasedAt >= rule.endsAt) return false;
  if (c.locationIds && !c.locationIds.includes(txn.locationId)) return false;
  if (c.regionIds && !c.regionIds.some((r) => txn.regionIds.includes(r))) return false;
  if (c.tierRanks && (member.tierRank === null || !c.tierRanks.includes(member.tierRank))) return false;
  if (c.minEligibleMinor !== undefined && eligibleMinor < c.minEligibleMinor) return false;
  if (c.daysOfWeek && !c.daysOfWeek.includes(dayOfWeek(txn.purchasedAt, txn.timezone))) return false;
  return true;
}

/**
 * Evaluates one purchase.
 *  - base_rate: the single highest-priority (lowest number) matching rule;
 *    points_per_unit × eligible major units × tier multiplier.
 *  - multiplier: each matching rule adds base × (multiplier − 1) as a bonus.
 *  - fixed_bonus / spend_threshold_bonus: bonus_points once when conditions hold
 *    (spend_threshold_bonus requires conditions.minEligibleMinor).
 *  - product_bonus: over matching items, bonus_points × quantity, or
 *    points_per_unit × their spend.
 *  - visit_bonus: bonus_points when this visit is a multiple of
 *    conditions.everyNthVisit (or every visit when unset).
 * Each line is rounded with the version's rounding mode.
 */
export function evaluateEarning(input: { config: LoyaltyProgramVersionConfig; rules: EarningRule[]; txn: EarningTransaction; member: EarningMember }): EarningResult {
  const { config, txn, member } = input;
  const eligibleMinor = eligibleAmountMinor(txn, config);
  if (eligibleMinor <= 0) return EMPTY(0);
  if (config.earningLocations !== "all_participating" && !config.earningLocations.includes(txn.locationId)) return EMPTY(eligibleMinor);

  const perMajor = minorPerMajor(txn.currency);
  const rules = [...input.rules].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const parsed = rules.map((r) => ({ rule: r, c: EarningRuleConditions.parse(r.conditions ?? {}) }));
  const active = parsed.filter(({ rule, c }) => applies(rule, c, txn, member, eligibleMinor));

  let base: EarningLine | null = null;
  const baseRule = active.find(({ rule }) => rule.ruleType === "base_rate" && rule.pointsPerUnit !== null);
  let rawBase = 0;
  if (baseRule) {
    rawBase = (eligibleMinor / perMajor) * baseRule.rule.pointsPerUnit! * member.tierMultiplier;
    const points = round(rawBase, config.rounding);
    base = { ruleId: baseRule.rule.id, ruleType: "base_rate", name: baseRule.rule.name, points };
  }

  const visitNumber = member.priorVisitsInPeriod + 1;
  const bonuses: EarningLine[] = [];
  for (const { rule, c } of active) {
    let points = 0;
    switch (rule.ruleType) {
      case "multiplier":
        if (rule.multiplier !== null && rawBase > 0) points = round(rawBase * (rule.multiplier - 1), config.rounding);
        break;
      case "fixed_bonus":
        points = rule.bonusPoints ?? 0;
        break;
      case "spend_threshold_bonus":
        if (c.minEligibleMinor !== undefined) points = rule.bonusPoints ?? 0;
        break;
      case "product_bonus": {
        const items = matchingItems(c, txn, config);
        if (!c.productRefs && !c.categories) break;
        if (rule.bonusPoints !== null) points = round(items.reduce((n, i) => n + i.quantity, 0) * rule.bonusPoints, config.rounding);
        else if (rule.pointsPerUnit !== null) points = round((items.reduce((n, i) => n + i.totalMinor, 0) / perMajor) * rule.pointsPerUnit, config.rounding);
        break;
      }
      case "visit_bonus":
        if (!c.everyNthVisit || visitNumber % c.everyNthVisit === 0) points = rule.bonusPoints ?? 0;
        break;
      case "base_rate":
        break;
    }
    if (points > 0) bonuses.push({ ruleId: rule.id, ruleType: rule.ruleType, name: rule.name, points });
  }

  const basePoints = base?.points ?? 0;
  const bonusPoints = bonuses.reduce((n, b) => n + b.points, 0);
  return {
    eligibleMinor,
    basePoints,
    bonusPoints,
    base: base && base.points > 0 ? base : null,
    bonuses,
    qualifyingVisits: 1,
    ruleIds: [...(base && base.points > 0 ? [base.ruleId] : []), ...bonuses.map((b) => b.ruleId)],
  };
}

export type QualificationPeriod = LoyaltyProgramVersionConfig["qualification"]["period"];

/** The qualification window containing `now`. Dates are UTC calendar dates. */
export function qualificationWindow(period: QualificationPeriod, now: Date, accountOpenedAt: Date): { start: Date; end: Date | null } {
  if (period === "calendar_year") {
    return { start: new Date(Date.UTC(now.getUTCFullYear(), 0, 1)), end: new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1)) };
  }
  if (period === "rolling_12_months") {
    return { start: new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate())), end: null };
  }
  return { start: accountOpenedAt, end: null };
}

export interface TierDef { id: string; rank: number; qualificationThreshold: number; earningMultiplier: number }

/** Highest-ranked tier whose threshold the progress meets, or null. */
export function tierForProgress<T extends TierDef>(tiers: T[], progress: number): T | null {
  return [...tiers].sort((a, b) => b.rank - a.rank).find((t) => progress >= t.qualificationThreshold) ?? null;
}

/** The next tier above `current` (by rank), or the lowest tier when the member has none. */
export function nextTierAfter<T extends TierDef>(tiers: T[], current: T | null): T | null {
  const sorted = [...tiers].sort((a, b) => a.rank - b.rank);
  return current ? sorted.find((t) => t.rank > current.rank) ?? null : sorted[0] ?? null;
}
