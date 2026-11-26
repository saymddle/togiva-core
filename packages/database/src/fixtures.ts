import { randomUUID } from "node:crypto";
import type pg from "pg";

/**
 * Test fixture builders. They write as the superuser test connection and are
 * for automated tests only. All names are obviously synthetic.
 */
export class Fixtures {
  constructor(private readonly admin: pg.Client) {}

  async organization(opts: { slug?: string; name?: string } = {}): Promise<string> {
    const slug = opts.slug ?? `fixture-${randomUUID().slice(0, 8)}`;
    const { rows } = await this.admin.query<{ id: string }>(
      "insert into togiva.organizations (slug, name, status) values ($1, $2, 'active') returning id",
      [slug, opts.name ?? `Fixture Org ${slug}`],
    );
    const id = rows[0]!.id;
    await this.admin.query("insert into togiva.organization_settings (organization_id) values ($1)", [id]);
    return id;
  }

  async location(orgId: string, opts: { name?: string; participating?: boolean; status?: string } = {}): Promise<string> {
    const { rows } = await this.admin.query<{ id: string }>(
      `insert into togiva.locations (organization_id, store_code, name, status, loyalty_participating)
       values ($1, $2, $3, $4, $5) returning id`,
      [orgId, `S-${randomUUID().slice(0, 6)}`, opts.name ?? "Fixture Store", opts.status ?? "active", opts.participating ?? true],
    );
    return rows[0]!.id;
  }

  async region(orgId: string, name = `Region ${randomUUID().slice(0, 4)}`): Promise<string> {
    const { rows } = await this.admin.query<{ id: string }>(
      "insert into togiva.regions (organization_id, name) values ($1, $2) returning id",
      [orgId, name],
    );
    return rows[0]!.id;
  }

  async assignLocationToRegion(orgId: string, locationId: string, regionId: string): Promise<void> {
    await this.admin.query(
      "insert into togiva.location_regions (organization_id, location_id, region_id) values ($1, $2, $3)",
      [orgId, locationId, regionId],
    );
  }

  async user(opts: { firstName?: string; email?: string } = {}): Promise<string> {
    const id = randomUUID();
    await this.admin.query(
      "insert into togiva.user_profiles (id, email, first_name, email_verified_at) values ($1, $2, $3, now())",
      [id, opts.email ?? `${id}@example.test`, opts.firstName ?? "Fixture"],
    );
    return id;
  }

  async roleId(key: string): Promise<string> {
    const { rows } = await this.admin.query<{ id: string }>(
      "select id from togiva.role_definitions where key = $1 and organization_id is null",
      [key],
    );
    if (!rows[0]) throw new Error(`unknown role ${key}`);
    return rows[0].id;
  }

  /** Adds an organization membership; with an organization-scoped role if given. */
  async orgMember(orgId: string, userId: string, roleKey?: "corporate_admin" | "corporate_analyst"): Promise<void> {
    const roleId = roleKey ? await this.roleId(roleKey) : null;
    await this.admin.query(
      `insert into togiva.organization_memberships (organization_id, user_id, role_id, status) values ($1, $2, $3, 'active')
       on conflict (organization_id, user_id) do update set role_id = coalesce(excluded.role_id, togiva.organization_memberships.role_id)`,
      [orgId, userId, roleId],
    );
  }

  async locationStaff(orgId: string, locationId: string, userId: string, roleKey: "general_manager" | "store_employee"): Promise<void> {
    await this.orgMember(orgId, userId);
    await this.admin.query(
      "insert into togiva.location_memberships (organization_id, location_id, user_id, role_id) values ($1, $2, $3, $4)",
      [orgId, locationId, userId, await this.roleId(roleKey)],
    );
  }

  async regionalManager(orgId: string, regionId: string, userId: string): Promise<void> {
    await this.orgMember(orgId, userId);
    await this.admin.query(
      "insert into togiva.region_memberships (organization_id, region_id, user_id, role_id) values ($1, $2, $3, $4)",
      [orgId, regionId, userId, await this.roleId("regional_manager")],
    );
  }

  async franchiseOwner(orgId: string, userId: string, locationIds: string[]): Promise<string> {
    await this.orgMember(orgId, userId);
    const { rows } = await this.admin.query<{ id: string }>(
      "insert into togiva.franchise_owners (organization_id, legal_name) values ($1, 'Fixture Franchise LLC') returning id",
      [orgId],
    );
    const ownerId = rows[0]!.id;
    const m = await this.admin.query<{ id: string }>(
      "insert into togiva.franchise_owner_members (organization_id, franchise_owner_id, user_id) values ($1, $2, $3) returning id",
      [orgId, ownerId, userId],
    );
    await this.admin.query(
      "insert into togiva.franchise_role_assignments (organization_id, franchise_owner_member_id, role_id) values ($1, $2, $3)",
      [orgId, m.rows[0]!.id, await this.roleId("franchise_owner")],
    );
    for (const loc of locationIds) {
      await this.admin.query(
        "insert into togiva.franchise_location_ownerships (organization_id, franchise_owner_id, location_id) values ($1, $2, $3)",
        [orgId, ownerId, loc],
      );
    }
    return ownerId;
  }

  /** Creates a customer identity and enrolls it in the organization. */
  async customer(orgId: string, opts: { userId?: string; firstName?: string } = {}): Promise<{ userId: string; customerProfileId: string; organizationCustomerId: string; membershipNumber: string }> {
    const userId = opts.userId ?? (await this.user({ firstName: opts.firstName ?? "Casey" }));
    const existing = await this.admin.query<{ id: string }>("select id from togiva.customer_profiles where user_id = $1", [userId]);
    const customerProfileId =
      existing.rows[0]?.id ??
      (await this.admin.query<{ id: string }>(
        "insert into togiva.customer_profiles (user_id, first_name, last_name) values ($1, $2, 'Fixture') returning id",
        [userId, opts.firstName ?? "Casey"],
      )).rows[0]!.id;
    const membershipNumber = String(Math.floor(1e9 + Math.random() * 9e9));
    const { rows } = await this.admin.query<{ id: string }>(
      "insert into togiva.organization_customers (organization_id, customer_profile_id, membership_number) values ($1, $2, $3) returning id",
      [orgId, customerProfileId, membershipNumber],
    );
    return { userId, customerProfileId, organizationCustomerId: rows[0]!.id, membershipNumber };
  }

  async posConnection(orgId: string, provider = "fixture"): Promise<string> {
    const { rows } = await this.admin.query<{ id: string }>(
      `insert into togiva.pos_connections (organization_id, provider_code, environment, merchant_external_id, status)
       values ($1, $2, 'fixture', $3, 'active') returning id`,
      [orgId, provider, `merchant-${randomUUID().slice(0, 8)}`],
    );
    return rows[0]!.id;
  }
}
