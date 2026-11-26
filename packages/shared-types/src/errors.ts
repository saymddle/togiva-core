import { z } from "zod";

/**
 * Stable machine-readable error codes. Clients branch on `code`, never on
 * message text. HTTP status is advisory.
 */
export const ApiErrorCode = z.enum([
  "unauthenticated",
  "forbidden",
  "not_found",
  "validation_failed",
  "conflict",
  "rate_limited",
  "idempotency_conflict",
  "membership_required",
  "location_not_participating",
  // connection codes
  "connection_code_invalid",
  "connection_code_expired",
  "connection_code_already_used",
  "connection_code_locked_out",
  "connection_code_reservation_expired",
  "connection_code_not_reserved_by_you",
  "connection_code_space_exhausted",
  "order_already_associated",
  // loyalty
  "loyalty_program_unavailable",
  "insufficient_points",
  "reward_unavailable",
  "redemption_invalid",
  "redemption_expired",
  "redemption_already_completed",
  "redemption_wrong_location",
  "internal_error",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

export const ApiError = z.object({
  error: z.object({
    code: ApiErrorCode,
    message: z.string(),
    requestId: z.string().optional(),
    details: z.unknown().optional(),
    /** Seconds; present with rate_limited and connection_code_locked_out. */
    retryAfterSeconds: z.number().int().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;
