import { z } from "zod";

/**
 * Permission codes. Must match the rows seeded in
 * packages/database/migrations/0002_organizations_and_access.sql (a test
 * enforces this). Add a permission by adding a migration AND updating this list.
 */
export const PERMISSIONS = [
  "organization.read",
  "organization.manage",
  "location.read",
  "location.manage",
  "region.read",
  "region.manage",
  "franchise.read",
  "franchise.manage",
  "staff.read",
  "staff.manage",
  "customer.identify",
  "customer.read_membership",
  "customer.read_pii",
  "customer.manage",
  "connection.associate",
  "loyalty.read",
  "loyalty.configure",
  "loyalty.adjust.request",
  "loyalty.adjust.approve",
  "rewards.read",
  "rewards.manage",
  "rewards.redeem.verify",
  "campaigns.read",
  "campaigns.manage",
  "analytics.location.read",
  "analytics.network.read",
  "transactions.read",
  "pos.read",
  "pos.manage",
  "support.submit",
  "support.resolve",
  "audit.read",
] as const;
export const Permission = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof Permission>;

/** Platform-provided role templates (organization_id is null in role_definitions). */
export const SYSTEM_ROLES = [
  "corporate_admin",
  "corporate_analyst",
  "regional_manager",
  "franchise_owner",
  "general_manager",
  "store_employee",
] as const;
export const SystemRoleKey = z.enum(SYSTEM_ROLES);
export type SystemRoleKey = z.infer<typeof SystemRoleKey>;

/**
 * The eight actor kinds from the product brief. "platform_super_admin" is a
 * platform grant (platform_admins table), "customer" is an organization
 * membership (organization_customers); the rest are role assignments.
 */
export const ActorKind = z.enum(["platform_super_admin", ...SYSTEM_ROLES, "customer"]);
export type ActorKind = z.infer<typeof ActorKind>;

export const RoleScope = z.enum(["organization", "region", "franchise", "location"]);
export type RoleScope = z.infer<typeof RoleScope>;
