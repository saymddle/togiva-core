import { randomInt } from "node:crypto";
import type { Database } from "@togiva/database";
import { isPgError, PgErrorCode } from "@togiva/database";
import type { EnrollmentRequest } from "@togiva/api-contracts";
import type { CustomerMembership } from "@togiva/shared-types";
import { AppError } from "../../errors.js";
import { customerMemberships } from "./service.js";

/**
 * Enrolls the caller as a member of an organization. One global
 * customer_profile per person; one organization_customers row per
 * organization. Idempotent.
 *
 * Runs as the service role: organization_customers is not insertable by the
 * request role, because membership numbers and status are server-assigned.
 * Authorization here is "the caller is enrolling themselves in an active
 * organization", checked explicitly below.
 */
export async function enroll(db: Database, ctx: { userId: string; requestId: string }, organizationId: string, input: EnrollmentRequest): Promise<{ created: boolean; membership: CustomerMembership }> {
  const created = await db.asService(ctx, async (tx) => {
    const org = await tx.query("select 1 from togiva.organizations where id = $1 and status = 'active'", [organizationId]);
    if (org.rowCount === 0) throw new AppError("not_found", "Organization not found");

    const profile = await tx.query<{ id: string }>(
      `insert into togiva.customer_profiles (user_id, first_name, last_name, birth_month, birth_day)
       values ($1, $2, $3, $4, $5)
       on conflict (user_id) do update set first_name = coalesce(togiva.customer_profiles.first_name, excluded.first_name)
       returning id`,
      [ctx.userId, input.firstName, input.lastName ?? null, input.birthMonth ?? null, input.birthDay ?? null],
    );
    const profileId = profile.rows[0]!.id;
    const existing = await tx.query("select id from togiva.organization_customers where organization_id = $1 and customer_profile_id = $2", [organizationId, profileId]);
    if (existing.rowCount) return false;

    let ocId: string | undefined;
    for (let attempt = 0; attempt < 10 && !ocId; attempt++) {
      // 10-digit opaque membership number; only the last four are ever shown to staff.
      const number = String(randomInt(1_000_000_000, 9_999_999_999));
      try {
        await tx.query("savepoint enroll_attempt");
        const r = await tx.query<{ id: string }>(
          "insert into togiva.organization_customers (organization_id, customer_profile_id, membership_number) values ($1, $2, $3) returning id",
          [organizationId, profileId, number],
        );
        ocId = r.rows[0]!.id;
      } catch (err) {
        if (!isPgError(err, PgErrorCode.uniqueViolation)) throw err;
        await tx.query("rollback to savepoint enroll_attempt");
      }
    }
    if (!ocId) throw new AppError("internal_error", "Could not allocate a membership number");

    if (input.preferredLocationId) {
      const loc = await tx.query("select 1 from togiva.locations where id = $1 and organization_id = $2 and status = 'active' and loyalty_participating", [input.preferredLocationId, organizationId]);
      if (loc.rowCount === 0) throw new AppError("location_not_participating", "That location is not participating");
      await tx.query(
        "insert into togiva.customer_location_preferences (organization_id, organization_customer_id, location_id, is_preferred) values ($1, $2, $3, true)",
        [organizationId, ocId, input.preferredLocationId],
      );
    }
    for (const c of input.consents) {
      await tx.query(
        "insert into togiva.customer_consents (organization_id, organization_customer_id, consent_type, granted, policy_version) values ($1, $2, $3, $4, $5)",
        [organizationId, ocId, c.type, c.granted, c.policyVersion],
      );
    }
    await tx.query("select togiva.write_audit($1, 'customer.enrolled', 'organization_customer', $2)", [organizationId, ocId]);
    return true;
  });
  const membership = (await db.asUser(ctx, (tx) => customerMemberships(tx, organizationId)))[0];
  if (!membership) throw new AppError("internal_error", "Membership not visible after enrollment");
  return { created, membership };
}
