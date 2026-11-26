import { describe, expect, it } from "vitest";
import type { LoyaltyProgramVersionConfig } from "@togiva/shared-types";
import { eligibleAmountMinor, evaluateEarning, minorPerMajor, nextTierAfter, qualificationWindow, tierForProgress, type EarningRule, type EarningTransaction } from "../src/modules/loyalty/engine.js";

// Synthetic configuration for tests only; no client's real program values.
const config: LoyaltyProgramVersionConfig = {
  eligibleAmount: { include: ["subtotal", "discount"], excludeProductRefs: ["gift-card"], excludeCategories: [] },
  rounding: "floor",
  pointsExpireAfterMonths: null,
  qualification: { metric: "qualifying_spend", period: "calendar_year" },
  pendingPeriodSeconds: 0,
  earningLocations: "all_participating",
};

const txn = (over: Partial<EarningTransaction> = {}): EarningTransaction => ({
  currency: "USD", subtotalMinor: 1250, discountMinor: 0, taxMinor: 100, tipMinor: 200, serviceChargeMinor: 0, feeMinor: 0, totalMinor: 1550,
  refundedMinor: 0, voided: false, purchasedAt: new Date("2026-03-04T18:00:00Z"), locationId: "00000000-0000-4000-8000-000000000001",
  regionIds: [], timezone: "UTC", items: [], ...over,
});

let n = 0;
const rule = (over: Partial<EarningRule>): EarningRule => ({
  id: `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`, ruleType: "base_rate", name: "rule", priority: 100, pointsPerUnit: null, multiplier: null,
  bonusPoints: null, conditions: {}, startsAt: null, endsAt: null, status: "active", ...over,
});
const member = { tierRank: null, tierMultiplier: 1, priorVisitsInPeriod: 0 };
const base = rule({ name: "base", pointsPerUnit: 2 });

describe("eligible amount", () => {
  it("counts only configured components and subtracts discounts", () => {
    expect(eligibleAmountMinor(txn({ discountMinor: 250 }), config)).toBe(1000);
    expect(eligibleAmountMinor(txn(), { ...config, eligibleAmount: { ...config.eligibleAmount, include: ["subtotal", "tax", "tip"] } })).toBe(1550);
  });
  it("removes excluded items and scales down for partial refunds", () => {
    const withGiftCard = txn({ subtotalMinor: 3250, totalMinor: 3550, items: [{ productRef: "gift-card", category: null, quantity: 1, totalMinor: 2000 }] });
    expect(eligibleAmountMinor(withGiftCard, config)).toBe(1250);
    expect(eligibleAmountMinor(txn({ refundedMinor: 775 }), config)).toBe(625);
    expect(eligibleAmountMinor(txn({ voided: true }), config)).toBe(0);
  });
  it("knows minor units per currency", () => {
    expect(minorPerMajor("USD")).toBe(100);
    expect(minorPerMajor("JPY")).toBe(1);
  });
});

describe("earning", () => {
  it("applies the base rate with the configured rounding and tier multiplier", () => {
    expect(evaluateEarning({ config, rules: [base], txn: txn(), member }).basePoints).toBe(25); // 12.50 × 2
    expect(evaluateEarning({ config: { ...config, rounding: "ceil" }, rules: [rule({ pointsPerUnit: 1.5 })], txn: txn(), member }).basePoints).toBe(19);
    expect(evaluateEarning({ config, rules: [base], txn: txn(), member: { ...member, tierRank: 2, tierMultiplier: 1.5 } }).basePoints).toBe(37);
  });

  it("uses only the highest-priority matching base rule", () => {
    const special = rule({ pointsPerUnit: 5, priority: 10, conditions: { locationIds: ["00000000-0000-4000-8000-000000000001"] } });
    const r = evaluateEarning({ config, rules: [base, special], txn: txn(), member });
    expect(r.basePoints).toBe(62);
    expect(r.ruleIds).toEqual([special.id]);
    expect(evaluateEarning({ config, rules: [base, special], txn: txn({ locationId: "00000000-0000-4000-8000-000000000002" }), member }).basePoints).toBe(25);
  });

  it("adds multiplier, threshold, product and visit bonuses separately from base", () => {
    const rules = [
      base,
      rule({ ruleType: "multiplier", name: "double", multiplier: 2 }),
      rule({ ruleType: "spend_threshold_bonus", bonusPoints: 10, conditions: { minEligibleMinor: 1000 } }),
      rule({ ruleType: "spend_threshold_bonus", bonusPoints: 99, conditions: { minEligibleMinor: 5000 } }),
      rule({ ruleType: "product_bonus", bonusPoints: 3, conditions: { categories: ["shakes"] } }),
      rule({ ruleType: "visit_bonus", bonusPoints: 50, conditions: { everyNthVisit: 5 } }),
    ];
    const items = [{ productRef: "p1", category: "shakes", quantity: 2, totalMinor: 800 }, { productRef: "p2", category: "sides", quantity: 1, totalMinor: 450 }];
    const r = evaluateEarning({ config, rules, txn: txn({ items }), member: { ...member, priorVisitsInPeriod: 4 } });
    expect(r.basePoints).toBe(25);
    expect(r.bonuses.map((b) => b.points)).toEqual([25, 10, 6, 50]);
    expect(r.bonusPoints).toBe(91);
    const notFifth = evaluateEarning({ config, rules, txn: txn({ items }), member: { ...member, priorVisitsInPeriod: 2 } });
    expect(notFifth.bonusPoints).toBe(41);
  });

  it("respects rule windows, tiers, regions and days of week", () => {
    const tierOnly = rule({ ruleType: "fixed_bonus", bonusPoints: 7, conditions: { tierRanks: [2] } });
    const region = rule({ ruleType: "fixed_bonus", bonusPoints: 11, conditions: { regionIds: ["00000000-0000-4000-8000-0000000000aa"] } });
    const tuesdaysInLA = rule({ ruleType: "fixed_bonus", bonusPoints: 13, conditions: { daysOfWeek: [2] } });
    const expired = rule({ ruleType: "fixed_bonus", bonusPoints: 17, endsAt: new Date("2026-01-01T00:00:00Z") });
    const disabled = rule({ ruleType: "fixed_bonus", bonusPoints: 19, status: "disabled" });
    const rules = [base, tierOnly, region, tuesdaysInLA, expired, disabled];
    // 2026-03-04T03:00Z is Wednesday in UTC but Tuesday evening in Los Angeles.
    const t = txn({ purchasedAt: new Date("2026-03-04T03:00:00Z"), timezone: "America/Los_Angeles", regionIds: ["00000000-0000-4000-8000-0000000000aa"] });
    expect(evaluateEarning({ config, rules, txn: t, member }).bonuses.map((b) => b.points)).toEqual([11, 13]);
    expect(evaluateEarning({ config, rules, txn: { ...t, timezone: "UTC" }, member: { ...member, tierRank: 2 } }).bonuses.map((b) => b.points)).toEqual([7, 11]);
  });

  it("earns nothing at locations outside the version's earning locations or with no eligible spend", () => {
    const limited = { ...config, earningLocations: ["00000000-0000-4000-8000-000000000009"] };
    expect(evaluateEarning({ config: limited, rules: [base], txn: txn(), member }).basePoints).toBe(0);
    const r = evaluateEarning({ config, rules: [base, rule({ ruleType: "fixed_bonus", bonusPoints: 5 })], txn: txn({ voided: true }), member });
    expect(r).toMatchObject({ basePoints: 0, bonusPoints: 0, qualifyingVisits: 0 });
  });

  it("has no built-in earning: with no rules nothing is awarded", () => {
    expect(evaluateEarning({ config, rules: [], txn: txn(), member })).toMatchObject({ eligibleMinor: 1250, basePoints: 0, bonusPoints: 0 });
  });
});

describe("tiers and qualification", () => {
  const tiers = [
    { id: "t1", rank: 1, qualificationThreshold: 0, earningMultiplier: 1 },
    { id: "t2", rank: 2, qualificationThreshold: 10_000, earningMultiplier: 1.25 },
    { id: "t3", rank: 3, qualificationThreshold: 50_000, earningMultiplier: 1.5 },
  ];
  it("picks the highest tier reached and the next one up", () => {
    expect(tierForProgress(tiers, 9_999)?.id).toBe("t1");
    expect(tierForProgress(tiers, 10_000)?.id).toBe("t2");
    expect(nextTierAfter(tiers, tiers[1]!)?.id).toBe("t3");
    expect(nextTierAfter(tiers, tiers[2]!)).toBeNull();
    expect(nextTierAfter(tiers, null)?.id).toBe("t1");
  });
  it("computes qualification windows", () => {
    const now = new Date("2026-11-26T12:00:00Z");
    expect(qualificationWindow("calendar_year", now, now)).toEqual({ start: new Date("2026-01-01T00:00:00Z"), end: new Date("2027-01-01T00:00:00Z") });
    expect(qualificationWindow("rolling_12_months", now, now).start).toEqual(new Date("2025-11-26T00:00:00Z"));
    const opened = new Date("2024-05-01T00:00:00Z");
    expect(qualificationWindow("lifetime", now, opened)).toEqual({ start: opened, end: null });
  });
});
