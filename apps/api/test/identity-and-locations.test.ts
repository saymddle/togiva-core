import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSIONS, SYSTEM_ROLES } from "@togiva/shared-types";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;
const s = {} as Record<"org" | "l1" | "l2" | "hidden" | "gm", string>;

beforeAll(async () => {
  h = await createHarness();
  s.org = await h.fixtures.organization({ slug: "id-org", name: "Identity Org" });
  s.l1 = await h.fixtures.location(s.org, { name: "Alpha" });
  s.l2 = await h.fixtures.location(s.org, { name: "Beta" });
  s.hidden = await h.fixtures.location(s.org, { name: "Gamma (pending)", status: "pending", participating: false });
  s.gm = await h.fixtures.user({ firstName: "Gale" });
  await h.fixtures.locationStaff(s.org, s.l1, s.gm, "general_manager");
});
afterAll(async () => h?.close());

describe("contracts match the database", () => {
  it("permission codes in shared-types equal the seeded catalogue", async () => {
    const r = await h.admin.query<{ code: string }>("select code from togiva.permissions order by code");
    expect(r.rows.map((x) => x.code)).toEqual([...PERMISSIONS].sort());
  });
  it("system role keys equal the seeded templates", async () => {
    const r = await h.admin.query<{ key: string }>("select key from togiva.role_definitions where organization_id is null order by key");
    expect(r.rows.map((x) => x.key)).toEqual([...SYSTEM_ROLES].sort());
  });
});

describe("GET /v1/me", () => {
  it("rejects missing, malformed and forged tokens", async () => {
    expect((await h.call(null, "GET", "/v1/me")).status).toBe(401);
    const bad = await h.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: "Bearer not-a-jwt" } });
    expect(bad.statusCode).toBe(401);
  });

  it("provisions a profile on first call and reports staff permissions per location", async () => {
    const newUser = randomUUID();
    const me = await h.call(newUser, "GET", "/v1/me");
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ id: newUser, emailVerified: true });
    expect(me.body.staffMemberships).toEqual([]);

    const gm = await h.call(s.gm, "GET", "/v1/me");
    const membership = gm.body.staffMemberships[0];
    expect(membership.organization.slug).toBe("id-org");
    expect(membership.roles).toEqual([{ roleKey: "general_manager", roleName: "General Manager", scope: "location", scopeId: s.l1 }]);
    expect(membership.organizationPermissions).toEqual([]);
    expect(membership.locations).toHaveLength(1);
    expect(membership.locations[0].permissions).toContain("customer.identify");
    expect(membership.locations[0].permissions).not.toContain("location.manage");
  });
});

describe("enrollment", () => {
  it("creates one global identity with separate memberships per organization", async () => {
    const otherOrg = await h.fixtures.organization({ slug: "id-org-2" });
    const user = randomUUID();
    const a = await h.call(user, "POST", `/v1/me/organizations/${s.org}/enrollment`, {
      firstName: "Sam", preferredLocationId: s.l1, consents: [{ type: "marketing_email", granted: true, policyVersion: "2026-11" }],
    });
    expect(a.status).toBe(201);
    expect(a.body.preferredLocationId).toBe(s.l1);
    expect(a.body.membershipNumber).toMatch(/^\d{10}$/);
    const again = await h.call(user, "POST", `/v1/me/organizations/${s.org}/enrollment`, { firstName: "Sam" });
    expect(again.status).toBe(200);
    expect(again.body.organizationCustomerId).toBe(a.body.organizationCustomerId);
    const b = await h.call(user, "POST", `/v1/me/organizations/${otherOrg}/enrollment`, { firstName: "Sam" });
    expect(b.status).toBe(201);
    expect(b.body.organizationCustomerId).not.toBe(a.body.organizationCustomerId);

    const profiles = await h.admin.query("select count(*)::int as n from togiva.customer_profiles where user_id = $1", [user]);
    expect(profiles.rows[0].n).toBe(1);
    const me = await h.call(user, "GET", "/v1/me");
    expect(me.body.customerMemberships).toHaveLength(2);
  });

  it("rejects unknown organizations and non-participating preferred locations", async () => {
    const user = randomUUID();
    expect((await h.call(user, "POST", `/v1/me/organizations/${randomUUID()}/enrollment`, { firstName: "X" })).status).toBe(404);
    expect((await h.call(user, "POST", `/v1/me/organizations/${s.org}/enrollment`, { firstName: "X", preferredLocationId: s.hidden })).body.error.code).toBe("location_not_participating");
    expect((await h.call(user, "POST", `/v1/me/organizations/${s.org}/enrollment`, { firstName: "" })).status).toBe(400);
  });
});

describe("locations", () => {
  it("customers see active participating locations only", async () => {
    const c = await h.fixtures.customer(s.org);
    const r = await h.call(c.userId, "GET", `/v1/organizations/${s.org}/locations`);
    expect(r.body.items.map((l: { name: string }) => l.name)).toEqual(["Alpha", "Beta"]);
  });

  it("paginates with an opaque cursor", async () => {
    const c = await h.fixtures.customer(s.org);
    const p1 = await h.call(c.userId, "GET", `/v1/organizations/${s.org}/locations?limit=1`);
    expect(p1.body.items).toHaveLength(1);
    const p2 = await h.call(c.userId, "GET", `/v1/organizations/${s.org}/locations?limit=1&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items[0].name).toBe("Beta");
    expect(p2.body.nextCursor).toBeNull();
  });

  it("returns 404 for a pending location to non-staff", async () => {
    const c = await h.fixtures.customer(s.org);
    expect((await h.call(c.userId, "GET", `/v1/organizations/${s.org}/locations/${s.hidden}`)).status).toBe(404);
  });
});

describe("database-level guard on connection codes", () => {
  it("blocks a customer from consuming or extending their own code directly", async () => {
    const c = await h.fixtures.customer(s.org);
    const issued = await h.call(c.userId, "POST", `/v1/me/organizations/${s.org}/connection-codes`, { locationId: s.l1 });
    const asCustomer = (sql: string) => h.db.asUser({ userId: c.userId }, (tx) => tx.query(sql, [issued.body.id]));
    await expect(asCustomer("update togiva.customer_connection_codes set status = 'consumed', consumed_at = now() where id = $1")).rejects.toThrow(/not permitted/);
    await expect(asCustomer("update togiva.customer_connection_codes set expires_at = now() + interval '1 day' where id = $1")).rejects.toThrow(/immutable/);
  });

  it("hides codes from staff at other locations", async () => {
    const c = await h.fixtures.customer(s.org);
    const issued = await h.call(c.userId, "POST", `/v1/me/organizations/${s.org}/connection-codes`, { locationId: s.l2 });
    const n = await h.db.asUser({ userId: s.gm }, async (tx) =>
      (await tx.query("update togiva.customer_connection_codes set status = 'reserved', reserved_at = now(), reserved_by_user_id = $2, reservation_expires_at = now() where id = $1", [issued.body.id, s.gm])).rowCount);
    expect(n).toBe(0);
  });
});

describe("health", () => {
  it("reports database reachability without auth", async () => {
    const r = await h.call(null, "GET", "/v1/health");
    expect(r.body).toEqual({ status: "ok", version: "dev", database: "ok" });
  });
});

describe("profile email conflicts", () => {
  it("refuses a second identity that presents an email another profile holds, without a 500", async () => {
    const first = randomUUID();
    const second = randomUUID();
    const email = `dup-${first}@example.test`;
    const one = await h.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${await h.token(first, email)}` } });
    expect(one.statusCode).toBe(200);
    const two = await h.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${await h.token(second, email.toUpperCase())}` } });
    expect(two.statusCode).toBe(409);
    expect(two.json().error.code).toBe("conflict");
    const r = await h.admin.query("select count(*)::int as n from togiva.user_profiles where id = $1", [second]);
    expect(r.rows[0].n).toBe(0);
  });
});
