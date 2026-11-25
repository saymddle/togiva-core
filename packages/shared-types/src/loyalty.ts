import { z } from "zod";

export const LedgerEntryType = z.enum(["earn", "bonus", "redeem", "redeem_reversal", "refund_reversal", "void_reversal", "adjustment", "expiration"]);
export type LedgerEntryType = z.infer<typeof LedgerEntryType>;

export const EligibleAmountComponent = z.enum(["subtotal", "discount", "tax", "tip", "service_charge", "fee"]);

/**
 * Stored in loyalty_program_versions.config. Every value is configured by the
 * organization; nothing here is a business default for any specific client.
 */
export const LoyaltyProgramVersionConfig = z.object({
  /** Which transaction components count toward eligible spend. */
  eligibleAmount: z.object({
    include: z.array(EligibleAmountComponent).min(1),
    excludeProductRefs: z.array(z.string()).default([]),
    excludeCategories: z.array(z.string()).default([]),
  }),
  rounding: z.enum(["floor", "round", "ceil"]),
  /** Points expire this many months after being earned; null = never. */
  pointsExpireAfterMonths: z.number().int().positive().nullable(),
  qualification: z.object({
    metric: z.enum(["qualifying_spend", "qualifying_visits", "qualifying_points"]),
    period: z.enum(["calendar_year", "rolling_12_months", "lifetime"]),
  }),
  /** Seconds after purchase before points become available (refund window); 0 = immediately. */
  pendingPeriodSeconds: z.number().int().nonnegative(),
  /** Which locations' purchases earn; "all_participating" or explicit list. */
  earningLocations: z.union([z.literal("all_participating"), z.array(z.uuid())]),
});
export type LoyaltyProgramVersionConfig = z.infer<typeof LoyaltyProgramVersionConfig>;

// ---- API DTOs (wallet, activity, rewards). Contracts are fixed now; the
// loyalty engine implementing them is Phase 4. -------------------------------

export const TierSummary = z.object({
  id: z.uuid(),
  rank: z.number().int().positive(),
  name: z.string(),
  description: z.string().nullable(),
  qualificationMetric: z.enum(["qualifying_spend", "qualifying_visits", "qualifying_points"]),
  qualificationThreshold: z.number().int().nonnegative(),
});
export type TierSummary = z.infer<typeof TierSummary>;

export const Wallet = z.object({
  organizationCustomerId: z.uuid(),
  membershipNumber: z.string(),
  availablePoints: z.number().int().nonnegative(),
  /** Earned but not yet available (pending POS confirmation or refund window). */
  pendingPoints: z.number().int().nonnegative(),
  currentTier: TierSummary.nullable(),
  nextTier: TierSummary.nullable(),
  qualification: z.object({
    metric: z.enum(["qualifying_spend", "qualifying_visits", "qualifying_points"]),
    periodStart: z.iso.date(),
    periodEnd: z.iso.date().nullable(),
    progress: z.number().int().nonnegative(),
    nextThreshold: z.number().int().nonnegative().nullable(),
  }),
  nextReward: z.object({ rewardId: z.uuid(), name: z.string(), pointsCost: z.number().int(), pointsNeeded: z.number().int().nonnegative() }).nullable(),
  /** "finalized" once all pending POS events are processed. */
  dataStatus: z.enum(["current", "pending_updates"]),
});
export type Wallet = z.infer<typeof Wallet>;

export const ActivityItem = z.object({
  id: z.string(),
  kind: z.enum(["purchase_pending", "purchase_earned", "bonus", "redemption", "reversal", "adjustment", "expiration"]),
  occurredAt: z.iso.datetime({ offset: true }),
  location: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  eligibleAmount: z.object({ amountMinor: z.number().int(), currency: z.string() }).nullable(),
  points: z.number().int(),
  bonusPoints: z.number().int(),
  description: z.string(),
});
export type ActivityItem = z.infer<typeof ActivityItem>;

export const RewardCategory = z.enum(["food", "drink", "side", "upgrade", "discount", "merchandise", "birthday", "exclusive", "limited_time", "surprise"]);

export const RewardSummary = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  category: RewardCategory,
  pointsCost: z.number().int().nonnegative(),
  imageRef: z.string().nullable(),
  availableFrom: z.iso.datetime({ offset: true }).nullable(),
  availableUntil: z.iso.datetime({ offset: true }).nullable(),
  minTierRank: z.number().int().nullable(),
  /** null = every participating location */
  locationIds: z.array(z.uuid()).nullable(),
  /** Evaluated server-side for the calling customer. */
  eligibility: z.object({ eligible: z.boolean(), reasons: z.array(z.enum(["insufficient_points", "tier_required", "not_available_at_location", "limit_reached", "out_of_stock", "not_yet_available", "expired"])) }).nullable(),
});
export type RewardSummary = z.infer<typeof RewardSummary>;

export const IssueRedemptionRequest = z.object({
  rewardId: z.uuid(),
  locationId: z.uuid(),
  idempotencyKey: z.string().min(8).max(128),
});

/** Redemption credential: high-entropy token (shown as QR or short text), never the 4-digit connection code. */
export const IssuedRedemption = z.object({
  id: z.uuid(),
  rewardId: z.uuid(),
  locationId: z.uuid(),
  status: z.enum(["issued", "completed", "expired", "cancelled", "reversed"]),
  token: z.string(),
  pointsCost: z.number().int(),
  expiresAt: z.iso.datetime({ offset: true }),
});
