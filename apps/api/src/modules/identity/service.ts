import { isPgError, PgErrorCode, type Database, type Queryable } from "@togiva/database";
import type { CustomerMembership, Me, OrganizationSummary, Permission, StaffMembership } from "@togiva/shared-types";
import type { Identity } from "../../auth/verifier.js";
import { AppError } from "../../errors.js";

/**
 * Creates or refreshes the user_profiles row from verified token claims.
 * Runs as the service role because user_profiles is not insertable by
 * request role. The id is the identity provider subject; nothing else from
 * the token is trusted for authorization.
 */
export async function ensureUserProfile(db: Database, identity: Identity, requestId: string): Promise<void> {
  try {
    await upsertProfile(db, identity, requestId);
  } catch (e) {
    // Emails are unique across profiles. A second identity-provider account
    // presenting an email another profile already holds (for example a
    // deleted and re-created sign-in) must not take over that profile.
    if (isPgError(e) && e.code === PgErrorCode.uniqueViolation && e.constraint === "user_profiles_email_key")
      throw new AppError("conflict", "This email address is already linked to a different account. Contact support to merge them.");
    throw e;
  }
}

async function upsertProfile(db: Database, identity: Identity, requestId: string): Promise<void> {
  await db.asService({ userId: identity.userId, requestId }, (tx) =>
    tx.query(
      `insert into togiva.user_profiles (id, email, email_verified_at)
       values ($1::uuid, coalesce($2::text, $1::uuid::text || '@unknown.invalid'), case when $3::boolean then now() end)
       on conflict (id) do update set
         email = coalesce($2::text, togiva.user_profiles.email),
         email_verified_at = case when $3::boolean then coalesce(togiva.user_profiles.email_verified_at, now()) else togiva.user_profiles.email_verified_at end`,
      [identity.userId, identity.email, identity.emailVerified],
    ),
  );
}

export const orgSummarySql = `json_build_object('id', o.id, 'slug', o.slug, 'name', o.name, 'status', o.status,
  'defaultCurrency', o.default_currency, 'defaultTimezone', o.default_timezone)`;

export async function getMe(db: Database, ctx: { userId: string; requestId: string }): Promise<Me> {
  return db.asUser(ctx, async (tx) => {
    const u = await tx.query<{ id: string; email: string; email_verified_at: Date | null; first_name: string | null; last_name: string | null }>(
      "select id, email, email_verified_at, first_name, last_name from togiva.user_profiles where id = $1",
      [ctx.userId],
    );
    const user = u.rows[0];
    if (!user) throw new Error("user profile missing after ensureUserProfile");
    const admin = await tx.query<{ ok: boolean }>("select togiva.is_platform_admin() as ok");
    return {
      user: { id: user.id, email: user.email, emailVerified: user.email_verified_at !== null, firstName: user.first_name, lastName: user.last_name },
      isPlatformAdmin: admin.rows[0]?.ok === true,
      staffMemberships: await staffMemberships(tx, ctx.userId),
      customerMemberships: await customerMemberships(tx),
    };
  });
}

async function staffMemberships(tx: Queryable, userId: string): Promise<StaffMembership[]> {
  const orgs = await tx.query<{ org: OrganizationSummary }>(
    `select ${orgSummarySql} as org from togiva.organization_memberships m join togiva.organizations o on o.id = m.organization_id
     where m.user_id = $1 and m.status = 'active' and togiva.is_active_org_member(o.id) order by o.name`,
    [userId],
  );
  const result: StaffMembership[] = [];
  for (const { org } of orgs.rows) {
    const roles = await tx.query<{ roleKey: string; roleName: string; scope: "organization" | "region" | "franchise" | "location"; scopeId: string }>(
      `select r.key as "roleKey", r.name as "roleName", 'organization' as scope, m.organization_id as "scopeId"
         from togiva.organization_memberships m join togiva.role_definitions r on r.id = m.role_id
        where m.user_id = $1 and m.organization_id = $2 and m.status = 'active'
       union all
       select r.key, r.name, 'region', rm.region_id from togiva.region_memberships rm join togiva.role_definitions r on r.id = rm.role_id
        where rm.user_id = $1 and rm.organization_id = $2 and rm.status = 'active'
       union all
       select r.key, r.name, 'franchise', fm.franchise_owner_id from togiva.franchise_owner_members fm
         join togiva.franchise_role_assignments fra on fra.franchise_owner_member_id = fm.id
         join togiva.role_definitions r on r.id = fra.role_id
        where fm.user_id = $1 and fm.organization_id = $2 and fm.status = 'active'
       union all
       select r.key, r.name, 'location', lm.location_id from togiva.location_memberships lm join togiva.role_definitions r on r.id = lm.role_id
        where lm.user_id = $1 and lm.organization_id = $2 and lm.status = 'active'`,
      [userId, org.id],
    );
    const orgPerms = await tx.query<{ code: Permission }>(
      "select code from togiva.permissions where togiva.has_org_permission($1, code) order by code",
      [org.id],
    );
    const locs = await tx.query<{ locationId: string; name: string; permissions: Permission[] }>(
      `select l.id as "locationId", l.name, array_agg(p.code order by p.code) as permissions
         from togiva.permissions p
         cross join lateral togiva.permitted_location_ids(p.code) pl
         join togiva.locations l on l.id = pl.location_id
        where pl.organization_id = $1
        group by l.id, l.name order by l.name`,
      [org.id],
    );
    result.push({ organization: org, roles: roles.rows, organizationPermissions: orgPerms.rows.map((r) => r.code), locations: locs.rows });
  }
  return result;
}

export async function customerMemberships(tx: Queryable, organizationId?: string): Promise<CustomerMembership[]> {
  const r = await tx.query<CustomerMembership>(
    `select ${orgSummarySql} as organization, oc.id as "organizationCustomerId", oc.membership_number as "membershipNumber",
            oc.status, to_json(oc.joined_at) #>> '{}' as "joinedAt",
            (select clp.location_id from togiva.customer_location_preferences clp
              where clp.organization_customer_id = oc.id and clp.is_preferred) as "preferredLocationId"
       from togiva.organization_customers oc
       join togiva.organizations o on o.id = oc.organization_id
      where oc.id in (select togiva.my_organization_customer_ids())
        and ($1::uuid is null or oc.organization_id = $1)
      order by o.name`,
    [organizationId ?? null],
  );
  return r.rows;
}
