import type { ApiErrorCode } from "@togiva/shared-types";

const STATUS: Partial<Record<ApiErrorCode, number>> = {
  unauthenticated: 401, forbidden: 403, not_found: 404, validation_failed: 400, conflict: 409, idempotency_conflict: 409,
  rate_limited: 429, membership_required: 403, location_not_participating: 422,
  connection_code_invalid: 404, connection_code_expired: 410, connection_code_already_used: 409, connection_code_locked_out: 429,
  connection_code_reservation_expired: 410, connection_code_not_reserved_by_you: 409, connection_code_space_exhausted: 503,
  order_already_associated: 409, internal_error: 500,
};

export class AppError extends Error {
  readonly status: number;
  constructor(readonly code: ApiErrorCode, message: string, readonly extra: { retryAfterSeconds?: number; details?: unknown } = {}) {
    super(message);
    this.status = STATUS[code] ?? 400;
  }
}
