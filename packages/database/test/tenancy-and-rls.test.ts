import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import type { Database } from "../src/index.js";
import { createTestDatabase, Fixtures } from "../src/test-utils.js";

let db: Database;
let admin: pg.Client;
let drop: () => Promise<void>;
let f: Fixtures;

const ids = {} as Record<"orgA" | "orgB" | "a1" | "a2" | "a3" | "b1" | "regionNorth" | "corpAdminA" | "analystA" | "corpAdminB" | "regional" | "owner" | "employeeA1" | "platformAdmin" | "customerA" | "ocA" | "customerB" | "ocB", string>;

beforeAll(async () => {
  ({ db, admin, drop } = await createTestDatabase());
  f = new Fixtures(admin);
  ids.orgA = await f.organization({ slug: "tenant-a" });
  ids.orgB = await f.organization({ slug: "tenant-b" });
  ids.a1 = await f.location(ids.orgA, { name: "A1" });
  ids.a2 = await f.location(ids.orgA, { name: "A2" });
  ids.a3 = await f.location(ids.orgA, { name: "A3" });
  ids.b1 = await f.location(ids.orgB, { name: "B1" });
  ids.regionNorth = await f.region(ids.orgA, "North");
  await f.assignLocationToRegion(ids.orgA, ids.a1, ids.regionNorth);
  await f.assignLocationToRegion(ids.orgA, ids.a2, ids.regionNorth);

  ids.corpAdminA = await f.user();
  await f.orgMember(ids.orgA, ids.corpAdminA, "corporate_admin");
  ids.analystA = await f.user();
  await f.orgMember(ids.orgA, ids.analystA, "corporate_analyst");
  ids.corpAdminB = await f.user();
  await f.orgMember(ids.orgB, ids.corpAdminB, "corporate_admin");
  ids.regional = await f.user();
  await f.regionalManager(ids.orgA, ids.regionNorth, ids.regional);
  ids.owner = await f.user();
  await f.franchiseOwner(ids.orgA, ids.owner, [ids.a1, ids.a3]);
  ids.employeeA1 = await f.user();
  await f.locationStaff(ids.orgA, ids.a1, ids.employeeA1, "store_employee");
  ids.platformAdmin = await f.user();
  await admin.query("insert into togiva.platform_admins (user_id) values ($1)", [ids.platformAdmin]);

  const cA = await f.customer(ids.orgA, { firstName: "Avery" });
  ids.customerA = cA.userId;
  ids.ocA = cA.organizationCustomerId;
  const cB = await f.customer(ids.orgB, { firstName: "Blake" });
  ids.customerB = cB.userId;
  ids.ocB = cB.organizationCustomerId;
});

afterAll(async () => drop?.());

const permittedLocations = (userId: string, perm: string) =>
  db.asUser({ userId }, async (tx) =>
    (await tx.query<{ name: string }>("select l.name from togiva.permitted_location_ids($1) p join togiva.locations l on l.id = p.location_id order by l.name", [perm])).rows.map((r) => r.name));

describe("schema guarantees", () => {
  it("enables row-level security on every togiva table", async () => {
    const { rows } = await admin.query("select tablename from pg_tables where schemaname = 'togiva' and not rowsecurity");
    expect(rows).toEqual([]);
  });

  it("keeps the loyalty ledger and audit log append-only, even for the service role", async () => {
    const acct = await admin.query<{ id: string }>(
      `with p as (insert into togiva.loyalty_programs (organization_id, name, status, currency) values ($1, 'Fixture Program', 'active', 'USD') returning id)
       insert into togiva.loyalty_accounts (organization_id, organization_customer_id, loyalty_program_id) select $1, $2, id from p returning id`,
      [ids.orgA, ids.ocA],
    );
    await admin.query(
      `insert into togiva.loyalty_ledger (organization_id, loyalty_account_id, entry_type, points, source_type, source_id, idempotency_key, occurred_at)
       values ($1, $2, 'adjustment', 10, 'migration', 'fixture', 'fixture-1', now())`,
      [ids.orgA, acct.rows[0]!.id],
    );
    await expect(db.asService({ userId: null }, (tx) => tx.query("update togiva.loyalty_ledger set points = 999"))).rejects.toThrow(/append-only/);
    await expect(db.asService({ userId: null }, (tx) => tx.query("delete from togiva.loyalty_ledger"))).rejects.toThrow(/append-only/);
    await db.asService({ userId: ids.corpAdminA }, (tx) => tx.query("select togiva.write_audit($1, 'test.event', 'test', 'x')", [ids.orgA]));
    await expect(db.asService({ userId: null }, (tx) => tx.query("delete from togiva.audit_logs"))).rejects.toThrow(/append-only/);
  });

  it("does not let the request role write the ledger or read POS credentials", async () => {
    await expect(
      db.asUser({ userId: ids.corpAdminA }, (tx) =>
        tx.query("insert into togiva.loyalty_ledger (organization_id, loyalty_account_id, entry_type, points, source_type, source_id, idempotency_key, occurred_at) values ($1, gen_random_uuid(), 'earn', 5, 'migration', 'x', 'y', now())", [ids.orgA])),
    ).rejects.toThrow(/permission denied/);
    await f.posConnection(ids.orgA);
    await expect(db.asUser({ userId: ids.corpAdminA }, (tx) => tx.query("select credentials_ciphertext from togiva.pos_connections"))).rejects.toThrow(/permission denied/);
    const ok = await db.asUser({ userId: ids.corpAdminA }, (tx) => tx.query("select id, status from togiva.pos_connections"));
    expect(ok.rowCount).toBe(1);
  });
});

describe("tenant isolation", () => {
  it("corporate admins see only their own organization", async () => {
    const orgs = await db.asUser({ userId: ids.corpAdminA }, async (tx) => (await tx.query<{ slug: string }>("select slug from togiva.organizations")).rows.map((r) => r.slug));
    expect(orgs).toEqual(["tenant-a"]);
    expect(await permittedLocations(ids.corpAdminA, "location.read")).toEqual(["A1", "A2", "A3"]);
    expect(await permittedLocations(ids.corpAdminB, "location.read")).toEqual(["B1"]);
    const customers = await db.asUser({ userId: ids.corpAdminA }, async (tx) => (await tx.query<{ id: string }>("select id from togiva.organization_customers")).rows.map((r) => r.id));
    expect(customers).toEqual([ids.ocA]);
  });

  it("customers see only their own memberships", async () => {
    const rows = await db.asUser({ userId: ids.customerA }, async (tx) => (await tx.query<{ id: string }>("select id from togiva.organization_customers")).rows);
    expect(rows.map((r) => r.id)).toEqual([ids.ocA]);
    const profiles = await db.asUser({ userId: ids.customerA }, async (tx) => (await tx.query("select first_name from togiva.customer_profiles")).rows);
    expect(profiles).toEqual([{ first_name: "Avery" }]);
  });

  it("platform super administrators see organizations but not customer data", async () => {
    const result = await db.asUser({ userId: ids.platformAdmin }, async (tx) => ({
      orgs: (await tx.query("select id from togiva.organizations")).rowCount,
      customers: (await tx.query("select id from togiva.organization_customers")).rowCount,
      profiles: (await tx.query("select id from togiva.customer_profiles")).rowCount,
    }));
    expect(result).toEqual({ orgs: 2, customers: 0, profiles: 0 });
  });

  it("anonymous requests see nothing tenant-scoped", async () => {
    const n = await db.asUser({ userId: null }, async (tx) => (await tx.query("select id from togiva.organization_customers")).rowCount);
    expect(n).toBe(0);
  });
});

describe("role scoping", () => {
  it("regional managers see only locations in their assigned region", async () => {
    expect(await permittedLocations(ids.regional, "location.read")).toEqual(["A1", "A2"]);
    expect(await permittedLocations(ids.regional, "location.manage")).toEqual([]);
  });

  it("franchise owners see only currently owned locations", async () => {
    expect(await permittedLocations(ids.owner, "location.read")).toEqual(["A1", "A3"]);
  });

  it("ended ownership removes access", async () => {
    const u = await f.user();
    const ownerId = await f.franchiseOwner(ids.orgA, u, [ids.a2]);
    expect(await permittedLocations(u, "location.read")).toEqual(["A2"]);
    await admin.query("update togiva.franchise_location_ownerships set effective_from = current_date - 10, effective_to = current_date where franchise_owner_id = $1", [ownerId]);
    expect(await permittedLocations(u, "location.read")).toEqual([]);
  });

  it("store employees are limited to their location and cannot read customer PII", async () => {
    expect(await permittedLocations(ids.employeeA1, "customer.identify")).toEqual(["A1"]);
    expect(await permittedLocations(ids.employeeA1, "analytics.location.read")).toEqual([]);
    const profiles = await db.asUser({ userId: ids.employeeA1 }, async (tx) => (await tx.query("select id from togiva.customer_profiles")).rowCount);
    expect(profiles).toBe(0);
  });

  it("corporate analysts cannot modify locations", async () => {
    const res = await db.asUser({ userId: ids.analystA }, (tx) => tx.query("update togiva.locations set name = 'X' where id = $1", [ids.a1]));
    expect(res.rowCount).toBe(0);
  });

  it("suspended organization members lose all access", async () => {
    const u = await f.user();
    await f.locationStaff(ids.orgA, ids.a2, u, "general_manager");
    expect(await permittedLocations(u, "location.read")).toEqual(["A2"]);
    await admin.query("update togiva.organization_memberships set status = 'suspended' where user_id = $1", [u]);
    expect(await permittedLocations(u, "location.read")).toEqual([]);
  });
});

describe("privilege escalation guards", () => {
  it("franchise owners may assign store roles at owned locations only", async () => {
    const newHire = await f.user();
    await f.orgMember(ids.orgA, newHire);
    const employeeRole = await f.roleId("store_employee");
    await db.asUser({ userId: ids.owner }, (tx) =>
      tx.query("insert into togiva.location_memberships (organization_id, location_id, user_id, role_id, created_by) values ($1, $2, $3, $4, $5)", [ids.orgA, ids.a1, newHire, employeeRole, ids.owner]));
    await expect(
      db.asUser({ userId: ids.owner }, (tx) =>
        tx.query("insert into togiva.location_memberships (organization_id, location_id, user_id, role_id) values ($1, $2, $3, $4)", [ids.orgA, ids.a2, newHire, employeeRole])),
    ).rejects.toThrow(/row-level security|not permitted/);
  });

  it("franchise owners cannot grant corporate or regional roles", async () => {
    const target = await f.user();
    const corp = await f.roleId("corporate_admin");
    await expect(
      db.asUser({ userId: ids.owner }, (tx) =>
        tx.query("insert into togiva.organization_memberships (organization_id, user_id, role_id) values ($1, $2, $3)", [ids.orgA, target, corp])),
    ).rejects.toThrow(/row-level security/);
    const regional = await f.roleId("regional_manager");
    await expect(
      db.asUser({ userId: ids.owner }, (tx) =>
        tx.query("insert into togiva.location_memberships (organization_id, location_id, user_id, role_id) values ($1, $2, $3, $4)", [ids.orgA, ids.a1, target, regional])),
    ).rejects.toThrow(/not permitted|row-level security/);
  });

  it("store employees cannot assign any roles", async () => {
    const target = await f.user();
    await expect(
      db.asUser({ userId: ids.employeeA1 }, async (tx) =>
        tx.query("insert into togiva.location_memberships (organization_id, location_id, user_id, role_id) values ($1, $2, $3, $4)", [ids.orgA, ids.a1, target, await f.roleId("store_employee")])),
    ).rejects.toThrow(/row-level security|not permitted/);
  });
});
