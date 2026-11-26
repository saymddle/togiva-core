import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConnectionCodeReservation, IssuedConnectionCode } from "@togiva/shared-types";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;
const s = {} as Record<"org" | "otherOrg" | "l1" | "l2" | "closed" | "pos" | "cashier1" | "cashier1b" | "cashier2" | "analyst" | "outsider", string>;

const issuePath = () => `/v1/me/organizations/${s.org}/connection-codes`;
const lookupPath = (loc = s.l1) => `/v1/organizations/${s.org}/locations/${loc}/connection-codes/lookup`;
const reservationPath = (id: string, action: "release" | "associate", loc = s.l1) => `/v1/organizations/${s.org}/locations/${loc}/connection-reservations/${id}/${action}`;
const key = () => `idem-${randomUUID()}`;

async function newCustomer(firstName = "Jordan") {
  const c = await h.fixtures.customer(s.org, { firstName });
  return c.userId;
}
async function issue(customer: string, loc = s.l1): Promise<IssuedConnectionCode> {
  const r = await h.call(customer, "POST", issuePath(), { locationId: loc });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return IssuedConnectionCode.parse(r.body);
}
async function lookup(staff: string, code: string, loc = s.l1, idempotencyKey = key()) {
  return h.call(staff, "POST", lookupPath(loc), { code, terminalId: "register-1", idempotencyKey });
}
async function associate(staff: string, reservationId: string, orderId: string, extra: Record<string, unknown> = {}) {
  return h.call(staff, "POST", reservationPath(reservationId, "associate"), { method: "order_reference", provider: "fixture", externalOrderId: orderId, idempotencyKey: key(), ...extra });
}
async function insertPosTransaction(orderId: string, status: string, loc = s.l1) {
  await h.admin.query(
    `insert into togiva.pos_transactions (organization_id, location_id, pos_connection_id, provider_code, external_transaction_id, external_order_id,
       currency, subtotal_minor, tax_minor, total_minor, status, purchased_at)
     values ($1, $2, $3, 'fixture', $4, $4, 'USD', 1000, 80, 1080, $5, now())`,
    [s.org, loc, s.pos, orderId, status],
  );
}
async function runJobs() {
  await h.admin.query("update togiva.background_jobs set run_at = now() where status in ('pending', 'failed')");
  while ((await h.worker.runOnce()) > 0) { /* drain */ }
}

beforeAll(async () => {
  h = await createHarness();
  s.org = await h.fixtures.organization({ slug: "cc-org" });
  s.otherOrg = await h.fixtures.organization({ slug: "cc-other" });
  s.l1 = await h.fixtures.location(s.org, { name: "Store One" });
  s.l2 = await h.fixtures.location(s.org, { name: "Store Two" });
  s.closed = await h.fixtures.location(s.org, { name: "Not Participating", participating: false });
  s.pos = await h.fixtures.posConnection(s.org);
  s.cashier1 = await h.fixtures.user({ firstName: "Cashier1" });
  await h.fixtures.locationStaff(s.org, s.l1, s.cashier1, "store_employee");
  s.cashier1b = await h.fixtures.user({ firstName: "Cashier1b" });
  await h.fixtures.locationStaff(s.org, s.l1, s.cashier1b, "store_employee");
  s.cashier2 = await h.fixtures.user({ firstName: "Cashier2" });
  await h.fixtures.locationStaff(s.org, s.l2, s.cashier2, "store_employee");
  s.analyst = await h.fixtures.user();
  await h.fixtures.orgMember(s.org, s.analyst, "corporate_analyst");
  s.outsider = await h.fixtures.user();
  await h.fixtures.locationStaff(s.otherOrg, await h.fixtures.location(s.otherOrg), s.outsider, "store_employee");
});
afterAll(async () => h?.close());
beforeEach(async () => {
  // Lockout state is per location; clear failed-attempt history between tests.
  await h.admin.query("alter table togiva.customer_connection_events disable trigger customer_connection_events_append_only");
  await h.admin.query("delete from togiva.customer_connection_events where event_type = 'lookup_failed'");
  await h.admin.query("alter table togiva.customer_connection_events enable trigger customer_connection_events_append_only");
});

describe("issuing", () => {
  it("issues a four-digit code bound to the chosen location with a five minute expiry", async () => {
    const c = await issue(await newCustomer());
    expect(c.code).toMatch(/^\d{4}$/);
    expect(c.location).toEqual({ id: s.l1, name: "Store One" });
    expect(c.ttlSeconds).toBe(300);
    expect(new Date(c.expiresAt).getTime() - new Date(c.issuedAt).getTime()).toBe(300_000);
  });

  it("never stores the raw code", async () => {
    const c = await issue(await newCustomer());
    const row = await h.admin.query("select * from togiva.customer_connection_codes where id = $1", [c.id]);
    expect(JSON.stringify(row.rows[0])).not.toContain(`"${c.code}"`);
    expect((row.rows[0].code_hash as Buffer).length).toBe(32);
  });

  it("requires membership and a participating location", async () => {
    const stranger = await h.fixtures.user();
    expect((await h.call(stranger, "POST", issuePath(), { locationId: s.l1 })).body.error.code).toBe("membership_required");
    const customer = await newCustomer();
    expect((await h.call(customer, "POST", issuePath(), { locationId: s.closed })).body.error.code).toBe("location_not_participating");
    expect((await h.call(null, "POST", issuePath(), { locationId: s.l1 })).status).toBe(401);
  });

  it("replacement invalidates the previous code", async () => {
    const customer = await newCustomer();
    const first = await issue(customer);
    const second = await issue(customer);
    const states = await h.admin.query("select id, status, revoked_reason from togiva.customer_connection_codes where id = any($1) order by created_at", [[first.id, second.id]]);
    expect(states.rows).toEqual([{ id: first.id, status: "revoked", revoked_reason: "replaced" }, { id: second.id, status: "active", revoked_reason: null }]);
    if (first.code !== second.code) expect((await lookup(s.cashier1, first.code)).body.error.code).toBe("connection_code_invalid");
    expect((await lookup(s.cashier1, second.code)).status).toBe(200);
  });

  it("changing location issues a code for the new location and revokes the old one", async () => {
    const customer = await newCustomer();
    const atOne = await issue(customer, s.l1);
    const atTwo = await issue(customer, s.l2);
    expect(atTwo.location.id).toBe(s.l2);
    const r = await h.admin.query("select status, revoked_reason from togiva.customer_connection_codes where id = $1", [atOne.id]);
    expect(r.rows[0]).toEqual({ status: "revoked", revoked_reason: "location_changed" });
  });

  it("keeps one active code per customer under concurrent requests", async () => {
    const customer = await newCustomer();
    await Promise.all(Array.from({ length: 5 }, () => h.call(customer, "POST", issuePath(), { locationId: s.l1 })));
    const r = await h.admin.query(
      "select count(*)::int as n from togiva.customer_connection_codes c join togiva.organization_customers oc on oc.id = c.organization_customer_id join togiva.customer_profiles p on p.id = oc.customer_profile_id where p.user_id = $1 and c.status = 'active'",
      [customer],
    );
    expect(r.rows[0].n).toBe(1);
  });

  it("rate limits code generation", async () => {
    const customer = await newCustomer();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await h.call(customer, "POST", issuePath(), { locationId: s.l1 })).status);
    expect(statuses.slice(0, 10).every((x) => x === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe("cashier lookup", () => {
  it("identifies the customer with minimal information and reserves the code", async () => {
    const customer = await newCustomer("Riley");
    const c = await issue(customer);
    const r = await lookup(s.cashier1, c.code);
    expect(r.status).toBe(200);
    const res = ConnectionCodeReservation.parse(r.body);
    expect(Object.keys(r.body.customer).sort()).toEqual(["firstName", "membershipNumberLast4", "membershipStatus", "tierName"]);
    expect(res.customer.firstName).toBe("Riley");
    expect(res.customer.membershipNumberLast4).toMatch(/^\d{4}$/);
    expect(JSON.stringify(r.body)).not.toMatch(/@example\.test|lastName|email|phone/);
    const row = await h.admin.query("select status, reserved_by_user_id, reserved_terminal_id from togiva.customer_connection_codes where id = $1", [c.id]);
    expect(row.rows[0]).toEqual({ status: "reserved", reserved_by_user_id: s.cashier1, reserved_terminal_id: "register-1" });
  });

  it("accepts leading-zero codes exactly", async () => {
    const customer = await newCustomer();
    const oc = await h.admin.query<{ id: string }>("select oc.id from togiva.organization_customers oc join togiva.customer_profiles p on p.id = oc.customer_profile_id where p.user_id = $1", [customer]);
    await h.admin.query("update togiva.customer_connection_codes set status = 'expired' where location_id = $1 and status = 'active'", [s.l1]);
    const { hash } = h.hasher.issue(s.org, s.l1, "0042");
    await h.admin.query(
      "insert into togiva.customer_connection_codes (organization_id, organization_customer_id, location_id, code_hash, expires_at) values ($1, $2, $3, $4, now() + interval '5 minutes')",
      [s.org, oc.rows[0]!.id, s.l1, hash],
    );
    expect((await lookup(s.cashier1, "42")).status).toBe(400);
    expect((await lookup(s.cashier1, "0420")).body.error?.code).toBe("connection_code_invalid");
    expect((await lookup(s.cashier1, "0042")).status).toBe(200);
  });

  it("rejects malformed input before touching the database", async () => {
    for (const code of ["123", "12345", "12a4", ""]) expect((await lookup(s.cashier1, code)).body.error.code).toBe("validation_failed");
  });

  it("returns invalid for an unknown code", async () => {
    const r = await lookup(s.cashier1, "9999");
    // 9999 may collide with a live code from another test; both outcomes are a real lookup.
    expect([200, 404]).toContain(r.status);
    if (r.status === 404) expect(r.body.error.code).toBe("connection_code_invalid");
  });

  it("rejects an expired code", async () => {
    const c = await issue(await newCustomer());
    await h.admin.query("update togiva.customer_connection_codes set created_at = now() - interval '10 minutes', expires_at = now() - interval '1 second' where id = $1", [c.id]);
    const r = await lookup(s.cashier1, c.code);
    expect(r.status).toBe(410);
    expect(r.body.error.code).toBe("connection_code_expired");
  });

  it("does not match a code at a different location (customer at the wrong store)", async () => {
    const c = await issue(await newCustomer(), s.l1);
    const r = await lookup(s.cashier2, c.code, s.l2);
    expect([404, 200]).toContain(r.status); // 200 only if an unrelated L2 code has the same digits
    if (r.status === 404) expect(r.body.error.code).toBe("connection_code_invalid");
    const row = await h.admin.query("select status from togiva.customer_connection_codes where id = $1", [c.id]);
    expect(row.rows[0].status).toBe("active");
  });

  it("forbids employees at other locations, other organizations, analysts and customers", async () => {
    const c = await issue(await newCustomer());
    expect((await lookup(s.cashier2, c.code, s.l1)).status).toBe(403);
    expect((await lookup(s.outsider, c.code, s.l1)).status).toBe(403);
    expect((await lookup(s.analyst, c.code, s.l1)).status).toBe(403);
    expect((await lookup(await newCustomer(), c.code, s.l1)).status).toBe(403);
    expect((await h.call(null, "POST", lookupPath(), { code: c.code, idempotencyKey: key() })).status).toBe(401);
    const row = await h.admin.query("select status from togiva.customer_connection_codes where id = $1", [c.id]);
    expect(row.rows[0].status).toBe("active");
  });

  it("lets exactly one of several simultaneous lookups win", async () => {
    const c = await issue(await newCustomer());
    const results = await Promise.all([s.cashier1, s.cashier1b, s.cashier1, s.cashier1b].map((who) => lookup(who, c.code)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.error.code === "connection_code_already_used")).toBe(true);
  });

  it("treats a retried lookup with the same idempotency key as the same reservation", async () => {
    const c = await issue(await newCustomer());
    const k = key();
    const a = await lookup(s.cashier1, c.code, s.l1, k);
    const b = await lookup(s.cashier1, c.code, s.l1, k);
    expect(b.status).toBe(200);
    expect(b.body.reservationId).toBe(a.body.reservationId);
  });

  it("locks out an employee after repeated invalid codes, even for valid ones", async () => {
    const c = await issue(await newCustomer());
    const wrong = c.code === "1111" ? "2222" : "1111";
    await h.admin.query("update togiva.customer_connection_codes set status = 'expired' where location_id = $1 and status = 'active' and id <> $2", [s.l1, c.id]);
    for (let i = 0; i < 5; i++) expect((await lookup(s.cashier1, wrong)).status).toBe(404);
    const locked = await lookup(s.cashier1, c.code);
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe("connection_code_locked_out");
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
    // another employee at the same store is not locked by this employee's failures
    expect((await lookup(s.cashier1b, c.code)).status).toBe(200);
  });

  it("release makes the code usable again", async () => {
    const c = await issue(await newCustomer());
    const r = await lookup(s.cashier1, c.code);
    expect((await h.call(s.cashier1b, "POST", reservationPath(r.body.reservationId, "release"))).body.error.code).toBe("connection_code_not_reserved_by_you");
    expect((await h.call(s.cashier1, "POST", reservationPath(r.body.reservationId, "release"))).status).toBe(204);
    expect((await lookup(s.cashier1b, c.code)).status).toBe(200);
  });
});

describe("association and POS confirmation", () => {
  async function reserved(customerName = "Morgan") {
    const customer = await newCustomer(customerName);
    const c = await issue(customer);
    const r = await lookup(s.cashier1, c.code);
    expect(r.status).toBe(200);
    return { customer, code: c, reservationId: r.body.reservationId as string };
  }

  it("associates an order, consumes the code, and awards nothing until the POS confirms", async () => {
    const { customer, code, reservationId } = await reserved();
    const order = `ORD-${randomUUID()}`;
    const a = await associate(s.cashier1, reservationId, order);
    expect(a.status).toBe(201);
    expect(a.body.status).toBe("pending_pos_confirmation");

    const cur = await h.call(customer, "GET", `${issuePath()}/current`);
    expect(cur.body.status).toBe("consumed");
    expect(cur.body.association.status).toBe("pending_pos_confirmation");
    expect((await lookup(s.cashier1, code.code)).body.error.code).toBe("connection_code_already_used");

    const ledger = await h.admin.query("select count(*)::int as n from togiva.loyalty_ledger");
    expect(ledger.rows[0].n).toBe(0);
  });

  it("confirms once a delayed POS transaction arrives, and hands off to loyalty exactly once", async () => {
    const { customer, reservationId } = await reserved();
    const order = `ORD-${randomUUID()}`;
    const a = await associate(s.cashier1, reservationId, order);
    await runJobs();
    let st = await h.admin.query("select status from togiva.customer_transaction_associations where id = $1", [a.body.id]);
    expect(st.rows[0].status).toBe("pending_pos_confirmation");
    const job = await h.admin.query("select status, attempts from togiva.background_jobs where idempotency_key = $1", [`assoc:${a.body.id}`]);
    expect(job.rows[0].status).toBe("failed"); // waiting with backoff, not lost

    await insertPosTransaction(order, "paid");
    await runJobs();
    st = await h.admin.query("select status, pos_transaction_id from togiva.customer_transaction_associations where id = $1", [a.body.id]);
    expect(st.rows[0].status).toBe("confirmed");
    expect(st.rows[0].pos_transaction_id).not.toBeNull();
    const cur = await h.call(customer, "GET", `${issuePath()}/current`);
    expect(cur.body.association.status).toBe("confirmed");

    // Re-running the reconcile (e.g. duplicate webhook triggering it again) changes nothing.
    await h.admin.query("select togiva.enqueue_job('connection_association.reconcile', $1::jsonb, $2, 'dup-1')", [JSON.stringify({ associationId: a.body.id }), s.org]);
    await runJobs();
    const handoffs = await h.admin.query("select count(*)::int as n from togiva.background_jobs where job_type = 'loyalty.process_association' and payload->>'associationId' = $1", [a.body.id]);
    expect(handoffs.rows[0].n).toBe(1);
  });

  it("rejects the association when the sale is voided", async () => {
    const { reservationId } = await reserved();
    const order = `ORD-${randomUUID()}`;
    await insertPosTransaction(order, "voided");
    const a = await associate(s.cashier1, reservationId, order);
    await runJobs();
    const st = await h.admin.query("select status, status_reason from togiva.customer_transaction_associations where id = $1", [a.body.id]);
    expect(st.rows[0]).toEqual({ status: "rejected", status_reason: "transaction_voided" });
  });

  it("confirms refunded sales so the loyalty engine can post the reversal", async () => {
    const { reservationId } = await reserved();
    const order = `ORD-${randomUUID()}`;
    await insertPosTransaction(order, "refunded");
    const a = await associate(s.cashier1, reservationId, order);
    await runJobs();
    const st = await h.admin.query("select status from togiva.customer_transaction_associations where id = $1", [a.body.id]);
    expect(st.rows[0].status).toBe("confirmed");
  });

  it("prevents one order being attached to two members", async () => {
    const order = `ORD-${randomUUID()}`;
    const first = await reserved("First");
    const second = await reserved("Second");
    expect((await associate(s.cashier1, first.reservationId, order)).status).toBe(201);
    const dup = await associate(s.cashier1, second.reservationId, order);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("order_already_associated");
    // the second customer's code is still reserved and can be used for the right order
    expect((await associate(s.cashier1, second.reservationId, `ORD-${randomUUID()}`)).status).toBe(201);
  });

  it("is idempotent on retried association requests", async () => {
    const { reservationId } = await reserved();
    const body = { method: "order_reference", provider: "fixture", externalOrderId: `ORD-${randomUUID()}`, idempotencyKey: key() };
    const a = await h.call(s.cashier1, "POST", reservationPath(reservationId, "associate"), body);
    const b = await h.call(s.cashier1, "POST", reservationPath(reservationId, "associate"), body);
    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
  });

  it("sends a never-confirmed purchase to review instead of losing it", async () => {
    const { reservationId } = await reserved();
    const a = await associate(s.cashier1, reservationId, `ORD-${randomUUID()}`);
    await h.admin.query("update togiva.customer_transaction_associations set created_at = now() - interval '25 hours' where id = $1", [a.body.id]);
    await runJobs();
    const st = await h.admin.query("select status, status_reason from togiva.customer_transaction_associations where id = $1", [a.body.id]);
    expect(st.rows[0]).toEqual({ status: "needs_review", status_reason: "pos_transaction_not_received" });
    const errs = await h.admin.query("select count(*)::int as n from togiva.integration_errors where details->>'associationId' = $1", [a.body.id]);
    expect(errs.rows[0].n).toBe(1);
  });

  it("lets a customer generate a new code mid-checkout without breaking the reserved one", async () => {
    const { customer, reservationId } = await reserved();
    const fresh = await issue(customer);
    expect(fresh.status).toBe("active");
    expect((await associate(s.cashier1, reservationId, `ORD-${randomUUID()}`)).status).toBe(201);
    const st = await h.admin.query("select status from togiva.customer_connection_codes where id = $1", [fresh.id]);
    expect(st.rows[0].status).toBe("active");
  });

  it("rejects association after the reservation times out", async () => {
    const { reservationId } = await reserved();
    await h.admin.query("update togiva.customer_connection_codes set reservation_expires_at = now() - interval '1 second' where id = $1", [reservationId]);
    const r = await associate(s.cashier1, reservationId, `ORD-${randomUUID()}`);
    expect(r.body.error.code).toBe("connection_code_reservation_expired");
  });

  it("only the reserving cashier can associate", async () => {
    const { reservationId } = await reserved();
    const r = await associate(s.cashier1b, reservationId, `ORD-${randomUUID()}`);
    expect(r.body.error.code).toBe("connection_code_not_reserved_by_you");
  });
});

describe("sweeper", () => {
  it("expires stale codes and records events", async () => {
    const c = await issue(await newCustomer());
    await h.admin.query("update togiva.customer_connection_codes set created_at = now() - interval '10 minutes', expires_at = now() - interval '1 second' where id = $1", [c.id]);
    await h.admin.query("select togiva.enqueue_job('connection_codes.sweep', '{}'::jsonb, null, $1)", [randomUUID()]);
    await runJobs();
    const st = await h.admin.query("select status from togiva.customer_connection_codes where id = $1", [c.id]);
    expect(st.rows[0].status).toBe("expired");
    const ev = await h.admin.query("select count(*)::int as n from togiva.customer_connection_events where connection_code_id = $1 and event_type = 'code_expired'", [c.id]);
    expect(ev.rows[0].n).toBe(1);
  });
});
