import { z } from "zod";
import { CurrencyCode, Timestamp, Uuid } from "./common.js";

export const PosProviderCode = z.enum(["clover", "toast", "square", "fixture"]);
export type PosProviderCode = z.infer<typeof PosProviderCode>;

export const PosTransactionStatus = z.enum(["open", "paid", "partially_refunded", "refunded", "voided"]);
export type PosTransactionStatus = z.infer<typeof PosTransactionStatus>;

export const NormalizedLineItem = z.object({
  externalLineId: z.string(),
  externalProductRef: z.string().nullable(),
  name: z.string(),
  category: z.string().nullable(),
  quantity: z.number().positive(),
  unitPriceMinor: z.number().int(),
  discountMinor: z.number().int().default(0),
  totalMinor: z.number().int(),
  refunded: z.boolean().default(false),
});
export type NormalizedLineItem = z.infer<typeof NormalizedLineItem>;

/**
 * Provider-independent transaction. Every adapter maps provider data into this
 * shape; the loyalty engine only ever sees this type. Amounts are minor units.
 */
export const NormalizedTransaction = z.object({
  organizationId: Uuid,
  locationId: Uuid,
  posConnectionId: Uuid,
  provider: PosProviderCode,
  externalTransactionId: z.string(),
  externalOrderId: z.string().nullable(),
  providerEventId: z.string().nullable(),
  externalCustomerRef: z.string().nullable(),
  currency: CurrencyCode,
  subtotalMinor: z.number().int(),
  discountMinor: z.number().int(),
  taxMinor: z.number().int(),
  tipMinor: z.number().int(),
  serviceChargeMinor: z.number().int(),
  feeMinor: z.number().int(),
  totalMinor: z.number().int(),
  refundedMinor: z.number().int().nonnegative(),
  status: PosTransactionStatus,
  purchasedAt: Timestamp,
  providerUpdatedAt: Timestamp.nullable(),
  lineItems: z.array(NormalizedLineItem),
});
export type NormalizedTransaction = z.infer<typeof NormalizedTransaction>;

/** What a provider can do. Unverified capabilities must be false. */
export const PosCapabilities = z.object({
  oauth: z.boolean(),
  webhooks: z.boolean(),
  webhookSignatureVerification: z.boolean(),
  /** Can TOGIVA attach a customer to an in-progress order through the provider API? */
  customerAttachToOpenOrder: z.boolean(),
  orderReferenceLookup: z.boolean(),
  recentTransactionsList: z.boolean(),
  refunds: z.boolean(),
  historicalSync: z.boolean(),
  /** Has each capability been verified against provider docs/sandbox? */
  verified: z.boolean(),
});
export type PosCapabilities = z.infer<typeof PosCapabilities>;

export interface PosWebhookVerificationInput {
  headers: Record<string, string | undefined>;
  rawBody: Buffer;
}

export interface PosInboundEvent {
  providerEventId: string;
  externalMerchantId: string;
  eventType: "transaction.upsert" | "transaction.refund" | "transaction.void" | "other";
  externalTransactionId: string | null;
  occurredAt: string;
  raw: unknown;
}

export interface PosAdapterContext {
  organizationId: string;
  posConnectionId: string;
  /** Decrypted credentials, only ever available inside the worker process. */
  credentials: Record<string, string>;
}

/**
 * Contract every POS provider implements (packages/pos-* in later phases).
 * The loyalty engine and connection workflow depend on this interface only.
 */
export interface PosAdapter {
  readonly provider: PosProviderCode;
  readonly capabilities: PosCapabilities;
  verifyWebhook(input: PosWebhookVerificationInput, webhookSecret: string): boolean;
  parseWebhook(rawBody: Buffer): PosInboundEvent[];
  fetchTransaction(ctx: PosAdapterContext, externalTransactionId: string, locationMap: Map<string, string>): Promise<NormalizedTransaction | null>;
  listTransactions(ctx: PosAdapterContext, window: { from: Date; to: Date; cursor?: string }, locationMap: Map<string, string>): Promise<{ items: NormalizedTransaction[]; nextCursor: string | null }>;
  /** Only when capabilities.customerAttachToOpenOrder is true. */
  attachCustomerToOrder?(ctx: PosAdapterContext, externalOrderId: string, externalCustomerRef: string): Promise<void>;
}
