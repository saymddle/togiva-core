import { z } from "zod";
import {
  ActivityItem,
  AssociateOrderRequest,
  ConnectionCodeReservation,
  ConnectionCodeState,
  CustomerMembership,
  IssueConnectionCodeRequest,
  IssuedConnectionCode,
  IssuedRedemption,
  IssueRedemptionRequest,
  LocationSummary,
  LookupConnectionCodeRequest,
  Me,
  OrganizationSummary,
  Page,
  PageQuery,
  RewardSummary,
  TransactionAssociation,
  Wallet,
} from "@togiva/shared-types";
import { defineRoute } from "./route.js";

const OrgParams = z.object({ organizationId: z.uuid() });
const SlugParams = z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/) });
const LocationParams = OrgParams.extend({ locationId: z.uuid() });
const ReservationParams = LocationParams.extend({ reservationId: z.uuid() });

export const EnrollmentRequest = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().max(80).optional(),
  preferredLocationId: z.uuid().optional(),
  birthMonth: z.number().int().min(1).max(12).optional(),
  birthDay: z.number().int().min(1).max(31).optional(),
  consents: z.array(z.object({ type: z.string().regex(/^[a-z_]+$/), granted: z.boolean(), policyVersion: z.string().min(1) })).default([]),
});
export type EnrollmentRequest = z.infer<typeof EnrollmentRequest>;

export const HealthResponse = z.object({ status: z.literal("ok"), version: z.string(), database: z.enum(["ok", "unavailable"]) });

export const v1 = {
  health: defineRoute({
    id: "health", method: "GET", path: "/v1/health", summary: "Liveness and database reachability",
    auth: "public", response: HealthResponse, successStatus: 200, errors: [], status: "implemented", owner: "platform",
  }),
  getMe: defineRoute({
    id: "getMe", method: "GET", path: "/v1/me", summary: "Current identity, staff roles, effective permissions and customer memberships",
    description: "Creates the user_profiles row on first call from verified token claims. Client apps use this to build role-based navigation; the server still authorizes every call.",
    auth: "user", response: Me, successStatus: 200, errors: ["unauthenticated"], status: "implemented", owner: "identity-access",
  }),
  enroll: defineRoute({
    id: "enroll", method: "POST", path: "/v1/me/organizations/{organizationId}/enrollment", summary: "Join an organization's membership program",
    description: "Creates the global customer profile if needed and an organization-specific membership. Idempotent: calling again returns the existing membership.",
    auth: "user", params: OrgParams, body: EnrollmentRequest, response: CustomerMembership, successStatus: 201,
    errors: ["unauthenticated", "not_found", "validation_failed"], status: "implemented", owner: "customer-identity",
  }),
  getOrganizationBySlug: defineRoute({
    id: "getOrganizationBySlug", method: "GET", path: "/v1/organizations/by-slug/{slug}",
    summary: "Resolve a client application's configured organization slug to its public summary (active organizations only)",
    auth: "public", params: SlugParams, response: OrganizationSummary, successStatus: 200,
    errors: ["not_found"], status: "implemented", owner: "organizations",
  }),
  listLocations: defineRoute({
    id: "listLocations", method: "GET", path: "/v1/organizations/{organizationId}/locations", summary: "Locations visible to the caller",
    description: "Staff see locations where they hold location.read. Customers and members see active, loyalty-participating locations.",
    auth: "user", params: OrgParams, query: PageQuery, response: Page(LocationSummary), successStatus: 200,
    errors: ["unauthenticated"], status: "implemented", owner: "organizations",
  }),
  getLocation: defineRoute({
    id: "getLocation", method: "GET", path: "/v1/organizations/{organizationId}/locations/{locationId}", summary: "One location",
    auth: "user", params: LocationParams, response: LocationSummary, successStatus: 200,
    errors: ["unauthenticated", "not_found"], status: "implemented", owner: "organizations",
  }),

  // ---- Connection codes: customer --------------------------------------------
  issueConnectionCode: defineRoute({
    id: "issueConnectionCode", method: "POST", path: "/v1/me/organizations/{organizationId}/connection-codes",
    summary: "Generate a four-digit connection code for a location",
    description: "Revokes the customer's previous active code (a code already reserved by a cashier is left to finish). The raw code is returned only in this response.",
    auth: "customer", params: OrgParams, body: IssueConnectionCodeRequest, response: IssuedConnectionCode, successStatus: 201,
    errors: ["unauthenticated", "membership_required", "location_not_participating", "rate_limited", "connection_code_space_exhausted"],
    status: "implemented", owner: "connection-codes",
  }),
  getCurrentConnectionCode: defineRoute({
    id: "getCurrentConnectionCode", method: "GET", path: "/v1/me/organizations/{organizationId}/connection-codes/current",
    summary: "State of the customer's most recent code (for countdown and pending purchase display)",
    auth: "customer", params: OrgParams, response: ConnectionCodeState, successStatus: 200,
    errors: ["unauthenticated", "membership_required", "not_found"], status: "implemented", owner: "connection-codes",
  }),
  cancelConnectionCode: defineRoute({
    id: "cancelConnectionCode", method: "DELETE", path: "/v1/me/organizations/{organizationId}/connection-codes/current",
    summary: "Revoke the customer's active code", auth: "customer", params: OrgParams, successStatus: 204,
    errors: ["unauthenticated", "membership_required"], status: "implemented", owner: "connection-codes",
  }),

  // ---- Connection codes: cashier ---------------------------------------------
  lookupConnectionCode: defineRoute({
    id: "lookupConnectionCode", method: "POST", path: "/v1/organizations/{organizationId}/locations/{locationId}/connection-codes/lookup",
    summary: "Identify a customer by code and reserve the code for this checkout",
    description: "Atomic: of concurrent lookups for the same code exactly one succeeds. Returns minimal identification only. Failed attempts count toward per-employee and per-location lockouts.",
    auth: "staff", permission: "customer.identify", params: LocationParams, body: LookupConnectionCodeRequest, response: ConnectionCodeReservation, successStatus: 200,
    errors: ["unauthenticated", "forbidden", "connection_code_invalid", "connection_code_expired", "connection_code_already_used", "connection_code_locked_out", "validation_failed"],
    status: "implemented", owner: "connection-codes",
  }),
  releaseConnectionReservation: defineRoute({
    id: "releaseConnectionReservation", method: "POST", path: "/v1/organizations/{organizationId}/locations/{locationId}/connection-reservations/{reservationId}/release",
    summary: "Cancel a reservation (wrong customer, abandoned checkout); the code becomes usable again until it expires",
    auth: "staff", permission: "customer.identify", params: ReservationParams, successStatus: 204,
    errors: ["unauthenticated", "forbidden", "not_found", "connection_code_not_reserved_by_you"], status: "implemented", owner: "connection-codes",
  }),
  associateOrder: defineRoute({
    id: "associateOrder", method: "POST", path: "/v1/organizations/{organizationId}/locations/{locationId}/connection-reservations/{reservationId}/associate",
    summary: "Attach the identified customer to a POS order and consume the code",
    description: "Creates an association in pending_pos_confirmation. No points are awarded here: the loyalty engine awards points only after the POS confirms the sale.",
    auth: "staff", permission: "connection.associate", params: ReservationParams, body: AssociateOrderRequest, response: TransactionAssociation, successStatus: 201,
    errors: ["unauthenticated", "forbidden", "not_found", "connection_code_reservation_expired", "connection_code_not_reserved_by_you", "order_already_associated", "idempotency_conflict"],
    status: "implemented", owner: "connection-codes",
  }),

  // ---- Loyalty (contracts fixed, implementation Phase 4) ---------------------
  getWallet: defineRoute({
    id: "getWallet", method: "GET", path: "/v1/me/organizations/{organizationId}/wallet", summary: "Points, tier progress and next reward",
    auth: "customer", params: OrgParams, response: Wallet, successStatus: 200, errors: ["unauthenticated", "membership_required"], status: "planned", owner: "loyalty",
  }),
  listActivity: defineRoute({
    id: "listActivity", method: "GET", path: "/v1/me/organizations/{organizationId}/activity", summary: "Purchases, points and redemptions, newest first",
    auth: "customer", params: OrgParams, query: PageQuery, response: Page(ActivityItem), successStatus: 200, errors: ["unauthenticated", "membership_required"], status: "planned", owner: "loyalty",
  }),
  listRewards: defineRoute({
    id: "listRewards", method: "GET", path: "/v1/me/organizations/{organizationId}/rewards", summary: "Reward catalog with per-customer eligibility",
    auth: "customer", params: OrgParams, query: PageQuery.extend({ locationId: z.uuid().optional() }), response: Page(RewardSummary), successStatus: 200,
    errors: ["unauthenticated", "membership_required"], status: "planned", owner: "loyalty",
  }),
  issueRedemption: defineRoute({
    id: "issueRedemption", method: "POST", path: "/v1/me/organizations/{organizationId}/redemptions", summary: "Reserve points for a reward and get a redemption token",
    auth: "customer", params: OrgParams, body: IssueRedemptionRequest, response: IssuedRedemption, successStatus: 201,
    errors: ["unauthenticated", "membership_required", "conflict", "idempotency_conflict"], status: "planned", owner: "loyalty",
  }),
} as const;

export type V1Routes = typeof v1;
export const v1Routes = Object.values(v1);
