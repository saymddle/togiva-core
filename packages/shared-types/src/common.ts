import { z } from "zod";

export const Uuid = z.uuid();
export type Uuid = z.infer<typeof Uuid>;

/** ISO-8601 timestamp with offset, as returned by the API. */
export const Timestamp = z.iso.datetime({ offset: true });
export type Timestamp = z.infer<typeof Timestamp>;

export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/);

/**
 * Money is always an integer count of minor units (cents) plus an ISO-4217
 * currency. Never floating point.
 */
export const Money = z.object({
  amountMinor: z.number().int(),
  currency: CurrencyCode,
});
export type Money = z.infer<typeof Money>;

export const Page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    /** Opaque cursor; absent on the last page. */
    nextCursor: z.string().nullable(),
  });

export const PageQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
