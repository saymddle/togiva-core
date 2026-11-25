import { z } from "zod";
import { Timestamp, Uuid } from "./common.js";

/** Exactly four ASCII digits, leading zeros allowed ("0042"). Always a string. */
export const ConnectionCodeDigits = z.string().regex(/^\d{4}$/, "Enter the 4-digit code");
export type ConnectionCodeDigits = z.infer<typeof ConnectionCodeDigits>;

export const ConnectionCodeStatus = z.enum(["active", "reserved", "consumed", "expired", "revoked"]);
export type ConnectionCodeStatus = z.infer<typeof ConnectionCodeStatus>;

export const AssociationStatus = z.enum(["pending_pos_confirmation", "confirmed", "needs_review", "rejected", "cancelled"]);
export type AssociationStatus = z.infer<typeof AssociationStatus>;

export const AssociationMethod = z.enum(["pos_customer_attach", "order_reference", "recent_transaction_select"]);
export type AssociationMethod = z.infer<typeof AssociationMethod>;

// ---- Customer side ---------------------------------------------------------

/**
 * Not idempotent by design: the raw code is never stored, so a retried request
 * issues a fresh code and revokes the previous one (which the customer never saw).
 */
export const IssueConnectionCodeRequest = z.object({
  locationId: Uuid,
});
export type IssueConnectionCodeRequest = z.infer<typeof IssueConnectionCodeRequest>;

/** The only response that ever contains the raw digits. */
export const IssuedConnectionCode = z.object({
  id: Uuid,
  code: ConnectionCodeDigits,
  status: z.literal("active"),
  location: z.object({ id: Uuid, name: z.string() }),
  issuedAt: Timestamp,
  expiresAt: Timestamp,
  ttlSeconds: z.number().int(),
});
export type IssuedConnectionCode = z.infer<typeof IssuedConnectionCode>;

/** Polling view for the customer: never includes the digits again. */
export const ConnectionCodeState = z.object({
  id: Uuid,
  status: ConnectionCodeStatus,
  location: z.object({ id: Uuid, name: z.string() }),
  expiresAt: Timestamp,
  association: z
    .object({
      id: Uuid,
      status: AssociationStatus,
      createdAt: Timestamp,
      confirmedAt: Timestamp.nullable(),
    })
    .nullable(),
});
export type ConnectionCodeState = z.infer<typeof ConnectionCodeState>;

// ---- Staff side ------------------------------------------------------------

export const LookupConnectionCodeRequest = z.object({
  code: ConnectionCodeDigits,
  /** POS terminal or register identifier, for audit. */
  terminalId: z.string().min(1).max(128).optional(),
  /** Same key on retry returns the same reservation instead of failing. */
  idempotencyKey: z.string().min(8).max(128),
});
export type LookupConnectionCodeRequest = z.infer<typeof LookupConnectionCodeRequest>;

/** Minimum information needed to confirm identity at the counter. */
export const ConnectionCodeReservation = z.object({
  reservationId: Uuid,
  locationId: Uuid,
  reservedAt: Timestamp,
  reservationExpiresAt: Timestamp,
  customer: z.object({
    firstName: z.string().nullable(),
    membershipStatus: z.enum(["active", "suspended", "closed"]),
    membershipNumberLast4: z.string(),
    tierName: z.string().nullable(),
  }),
});
export type ConnectionCodeReservation = z.infer<typeof ConnectionCodeReservation>;

export const AssociateOrderRequest = z
  .object({
    method: AssociationMethod,
    provider: z.string().regex(/^[a-z_]+$/),
    externalOrderId: z.string().min(1).max(256).optional(),
    externalTransactionId: z.string().min(1).max(256).optional(),
    /** When the cashier picked an already-ingested transaction from the recent list. */
    posTransactionId: z.uuid().optional(),
    terminalId: z.string().min(1).max(128).optional(),
    idempotencyKey: z.string().min(8).max(128),
  })
  .refine((v) => v.externalOrderId || v.externalTransactionId || v.posTransactionId, {
    message: "An order reference, transaction id or posTransactionId is required",
  });
export type AssociateOrderRequest = z.infer<typeof AssociateOrderRequest>;

export const TransactionAssociation = z.object({
  id: Uuid,
  status: AssociationStatus,
  method: AssociationMethod,
  locationId: Uuid,
  provider: z.string(),
  externalOrderId: z.string().nullable(),
  externalTransactionId: z.string().nullable(),
  posTransactionId: Uuid.nullable(),
  createdAt: Timestamp,
});
export type TransactionAssociation = z.infer<typeof TransactionAssociation>;
