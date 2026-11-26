import { z } from "zod";
import { CurrencyCode, Timestamp, Uuid } from "./common.js";
import { Permission, RoleScope } from "./access.js";

export const OrganizationStatus = z.enum(["onboarding", "active", "suspended", "closed"]);
export const LocationStatus = z.enum(["pending", "active", "inactive", "closed"]);

export const OrganizationSummary = z.object({
  id: Uuid,
  slug: z.string(),
  name: z.string(),
  status: OrganizationStatus,
  defaultCurrency: CurrencyCode,
  defaultTimezone: z.string(),
});
export type OrganizationSummary = z.infer<typeof OrganizationSummary>;

export const Address = z.object({
  line1: z.string().nullable(),
  line2: z.string().nullable(),
  city: z.string().nullable(),
  regionCode: z.string().nullable(),
  postalCode: z.string().nullable(),
  countryCode: z.string().length(2).nullable(),
});

export const LocationSummary = z.object({
  id: Uuid,
  organizationId: Uuid,
  storeCode: z.string(),
  name: z.string(),
  status: LocationStatus,
  loyaltyParticipating: z.boolean(),
  timezone: z.string(),
  address: Address,
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  phone: z.string().nullable(),
});
export type LocationSummary = z.infer<typeof LocationSummary>;

export const RoleAssignment = z.object({
  roleKey: z.string(),
  roleName: z.string(),
  scope: RoleScope,
  /** organization id, region id, franchise owner id or location id depending on scope */
  scopeId: Uuid,
});

export const StaffMembership = z.object({
  organization: OrganizationSummary,
  roles: z.array(RoleAssignment),
  /** Effective permissions at the organization level (corporate roles). */
  organizationPermissions: z.array(Permission),
  /** Locations where the user has any staff access, with effective permissions. */
  locations: z.array(z.object({ locationId: Uuid, name: z.string(), permissions: z.array(Permission) })),
});
export type StaffMembership = z.infer<typeof StaffMembership>;

export const CustomerMembership = z.object({
  organization: OrganizationSummary,
  organizationCustomerId: Uuid,
  membershipNumber: z.string(),
  status: z.enum(["active", "suspended", "closed"]),
  joinedAt: Timestamp,
  preferredLocationId: Uuid.nullable(),
});
export type CustomerMembership = z.infer<typeof CustomerMembership>;

/** GET /v1/me: who the caller is and what they can do. Drives role-based navigation. */
export const Me = z.object({
  user: z.object({
    id: Uuid,
    email: z.string(),
    emailVerified: z.boolean(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
  }),
  isPlatformAdmin: z.boolean(),
  staffMemberships: z.array(StaffMembership),
  customerMemberships: z.array(CustomerMembership),
});
export type Me = z.infer<typeof Me>;
