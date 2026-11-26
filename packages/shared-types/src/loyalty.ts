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
export type IssuedRedemption = z.infer<typeof IssuedRedemption>;
export type IssueRedemptionRequest = z.infer<typeof IssueRedemptionRequest>;

// ---- Phase 4: engine inputs and staff/customer loyalty DTOs ----------------

/**
 * loyalty_earning_rules.conditions. Every condition present must hold for the
 * rule to apply. All values are organization configuration.
 */
export const EarningRuleConditions = z.object({
  locationIds: z.array(z.uuid()).optional(),
  regionIds: z.array(z.uuid()).optional(),
  tierRanks: z.array(z.number().int().positive()).optional(),
  productRefs: z.array(z.string()).optional(),
  categories: z.array(z.string()).optional(),
  minEligibleMinor: z.number().int().nonnegative().optional(),
  /** 0 = Sunday … 6 = Saturday, evaluated in the location's time zone. */
  daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
  /** visit_bonus: award on every Nth qualifying visit within the qualification period. */
  everyNthVisit: z.number().int().positive().optional(),
});
export type EarningRuleConditions = z.infer<typeof EarningRuleConditions>;

export const RedemptionStatus = z.enum(["issued", "completed", "expired", "cancelled", "reversed"]);

/** What a cashier sees when a customer presents a redemption token. Minimal identification only. */
export const RedemptionVerification = z.object({
  id: z.uuid(),
  status: RedemptionStatus,
  reward: z.object({ id: z.uuid(), name: z.string(), posDiscountRef: z.string().nullable() }),
  customer: z.object({ firstName: z.string().nullable(), membershipLast4: z.string() }),
  locationId: z.uuid(),
  expiresAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type RedemptionVerification = z.infer<typeof RedemptionVerification>;

export const RedemptionTokenRequest = z.object({
  token: z.string().trim().min(8).max(64),
  terminalId: z.string().max(64).optional(),
});

export const CustomerRedemption = IssuedRedemption.omit({ token: true }).extend({
  rewardName: z.string(),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type CustomerRedemption = z.infer<typeof CustomerRedemption>;

export const AdjustmentRequestInput = z.object({
  organizationCustomerId: z.uuid(),
  locationId: z.uuid().optional(),
  points: z.number().int().refine((n) => n !== 0, "points must not be zero"),
  qualifyingAmountMinor: z.number().int().default(0),
  reason: z.string().trim().min(5).max(500),
  supportCaseId: z.uuid().optional(),
});

export const AdjustmentDecisionInput = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().max(500).optional(),
});

export const AdjustmentRequestSummary = z.object({
  id: z.uuid(),
  organizationCustomerId: z.uuid(),
  locationId: z.uuid().nullable(),
  points: z.number().int(),
  qualifyingAmountMinor: z.number().int(),
  reason: z.string(),
  status: z.enum(["pending", "approved", "rejected", "applied"]),
  requestedBy: z.uuid(),
  reviewedBy: z.uuid().nullable(),
  reviewedAt: z.iso.datetime({ offset: true }).nullable(),
  ledgerEntryId: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type AdjustmentRequestSummary = z.infer<typeof AdjustmentRequestSummary>;
