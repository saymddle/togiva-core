import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActivityItem, IssuedRedemption, Wallet } from "@togiva/shared-types";
import { createHarness, type Harness } from "./harness.js";

// Every program value below is synthetic test configuration, not any client's program.
let h: Harness;
const s = {} as Record<"org" | "l1" | "l2" | "pos" | "program" | "version" | "tier1" | "tier2" | "cashier" | "cashier2" | "gm" | "admin1" | "admin2", string>;
const key = () => `idem-${randomUUID()}`;

async function createProgram(orgId: string, opts: { pendingPeriodSeconds?: number } = {}) {
  const p = await h.admin.query<{ id: string }>("insert into togiva.loyalty_programs (organization_id, name, status, currency) values ($1, 'Test Program', 'active', 'USD') returning id", [orgId]);
  const config = {
    eligibleAmount: { include: ["subtotal", "discount"], excludeProductRefs: [], excludeCategories: [] },
    rounding: "floor", pointsExpireAfterMonths: null, qualification: { metric: "qualifying_spend", period: "calendar_year" },
    pendingPeriodSeconds: opts.pendingPeriodSeconds ?? 0, earningLocations: "all_participating",
  };
  const v = await h.admin.query<{ id: string }>(
    "insert into togiva.loyalty_program_versions (organization_id, loyalty_program_id, version, status, config, effective_from, published_at) values ($1, $2, 1, 'published', $3, now() - interval '1 day', now()) returning id",
    [orgId, p.rows[0]!.id, JSON.stringify(config)]);
  return { programId: p.rows[0]!.id, versionId: v.rows[0]!.id };
}
async function addRule(orgId: string, versionId: string, r: { type: string; pointsPerUnit?: number; bonusPoints?: number; conditions?: object; priority?: number }) {
  await h.admin.query(
    "insert into togiva.loyalty_earning_rules (organization_id, program_version_id, rule_type, name, priority, points_per_unit, bonus_points, conditions) values ($1, $2, $3, $3, $4, $5, $6, $7)",
    [orgId, versionId, r.type, r.priority ?? 100, r.pointsPerUnit ?? null, r.bonusPoints ?? null, JSON.stringify(r.conditions ?? {})]);
}
async function addTier(orgId: string, versionId: string, rank: number, threshold: number, multiplier: number) {
  const t = await h.admin.query<{ id: string }>(
    "insert into togiva.loyalty_tiers (organization_id, program_version_id, rank, name, qualification_threshold, earning_multiplier) values ($1, $2, $3, $4, $5, $6) returning id",
    [orgId, versionId, rank, `Tier ${rank}`, threshold, multiplier]);
  return t.rows[0]!.id;
}
async function addReward(opts: { cost: number; name?: string; minTierRank?: number; ttl?: number; locations?: string[]; stock?: number }) {
  const r = await h.admin.query<{ id: string }>(
    `insert into togiva.rewards (organization_id, loyalty_program_id, name, category, points_cost, status, min_tier_rank, redemption_ttl_seconds, all_participating_locations)
     values ($1, $2, $3, 'food', $4, 'active', $5, $6, $7) returning id`,
    [s.org, s.program, opts.name ?? `Reward ${opts.cost}`, opts.cost, opts.minTierRank ?? null, opts.ttl ?? 900, !opts.locations]);
  const id = r.rows[0]!.id;
  for (const l of opts.locations ?? []) await h.admin.query("insert into togiva.reward_location_eligibility (organization_id, reward_id, location_id) values ($1, $2, $3)", [s.org, id, l]);
  if (opts.stock !== undefined) await h.admin.query("insert into togiva.reward_inventory (organization_id, reward_id, quantity_total) values ($1, $2, $3)", [s.org, id, opts.stock]);
  return id;
}

async function runJobs() {
  for (let i = 0; i < 20; i++) {
    await h.admin.query("update togiva.background_jobs set run_at = now() where status in ('pending', 'failed')");
    if ((await h.worker.runOnce()) === 0) return;
  }
}

/** A confirmed member purchase, as association reconciliation leaves it, then the loyalty job. */
async function purchase(orgId: string, ocId: string, subtotalMinor: number, loc = s.l1, pos = s.pos) {
  const orderId = `order-${randomUUID().slice(0, 8)}`;
  const t = await h.admin.query<{ id: string }>(
    `insert into togiva.pos_transactions (organization_id, location_id, pos_connection_id, provider_code, external_transaction_id, external_order_id,
       currency, subtotal_minor, tax_minor, total_minor, status, purchased_at)
     values ($1, $2, $3, 'fixture', $4, $4, 'USD', $5, 0, $5, 'paid', now()) returning id`,
    [orgId, loc, pos, orderId, subtotalMinor]);
  const a = await h.admin.query<{ id: string }>(
    `insert into togiva.customer_transaction_associations (organization_id, location_id, organization_customer_id, provider_code, method, external_order_id,
       pos_transaction_id, status, associated_by_user_id, idempotency_key, confirmed_at)
     values ($1, $2, $3, 'fixture', 'order_reference', $4, $5, 'confirmed', $6, $7, now()) returning id`,
    [orgId, loc, ocId, orderId, t.rows[0]!.id, s.cashier, key()]);
  await h.admin.query("select togiva.enqueue_job('loyalty.process_association', $1::jsonb, $2, $3)",
    [JSON.stringify({ associationId: a.rows[0]!.id, posTransactionId: t.rows[0]!.id }), orgId, `loyalty-assoc:${a.rows[0]!.id}`]);
  await runJobs();
  return { txnId: t.rows[0]!.id, associationId: a.rows[0]!.id };
}

async function member(orgId = s.org) {
  const c = await h.fixtures.customer(orgId);
  return { user: c.userId, oc: c.organizationCustomerId };
}
const wallet = async (user: string, orgId = s.org) => {
  const r = await h.call(user, "GET", `/v1/me/organizations/${orgId}/wallet`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return Wallet.parse(r.body);
};
const redeemPath = (loc: string, action: "verify" | "complete") => `/v1/organizations/${s.org}/locations/${loc}/redemptions/${action}`;

beforeAll(async () => {
  h = await createHarness();
  s.org = await h.fixtures.organization({ slug: "loyalty-org" });
  s.l1 = await h.fixtures.location(s.org, { name: "Store One" });
  s.l2 = await h.fixtures.location(s.org, { name: "Store Two" });
  s.pos = await h.fixtures.posConnection(s.org);
  const p = await createProgram(s.org);
  s.program = p.programId;
  s.version = p.versionId;
  await addRule(s.org, s.version, { type: "base_rate", pointsPerUnit: 1 });
  await addRule(s.org, s.version, { type: "fixed_bonus", bonusPoints: 5, conditions: { locationIds: [s.l2] } });
  s.tier1 = await addTier(s.org, s.version, 1, 0, 1);
  s.tier2 = await addTier(s.org, s.version, 2, 5000, 2);
  s.cashier = await h.fixtures.user({ firstName: "Cashier" });
  await h.fixtures.locationStaff(s.org, s.l1, s.cashier, "store_employee");
  s.cashier2 = await h.fixtures.user({ firstName: "CashierTwo" });
  await h.fixtures.locationStaff(s.org, s.l2, s.cashier2, "store_employee");
  s.gm = await h.fixtures.user({ firstName: "Manager" });
  await h.fixtures.locationStaff(s.org, s.l1, s.gm, "general_manager");
  s.admin1 = await h.fixtures.user();
  await h.fixtures.orgMember(s.org, s.admin1, "corporate_admin");
  s.admin2 = await h.fixtures.user();
  await h.fixtures.orgMember(s.org, s.admin2, "corporate_admin");
});
afterAll(async () => h?.close());

describe("earning", () => {
  it("awards nothing and says so when the organization has no active program", async () => {
    const other = await h.fixtures.organization();
    const m = await member(other);
    const r = await h.call(m.user, "GET", `/v1/me/organizations/${other}/wallet`);
    expect(r.body.error.code).toBe("loyalty_program_unavailable");
    const loc = await h.fixtures.location(other);
    const pos = await h.fixtures.posConnection(other);
    await purchase(other, m.oc, 1000, loc, pos);
    const errs = await h.admin.query("select error_code from togiva.integration_errors where organization_id = $1", [other]);
    expect(errs.rows.map((e) => e.error_code)).toContain("loyalty_program_not_configured");
  });

  it("earns from a confirmed purchase through the full connection-code flow, never at association time", async () => {
    const m = await member();
    const fresh = await wallet(m.user);
    expect(fresh).toMatchObject({ availablePoints: 0, pendingPoints: 0, dataStatus: "current" });
    expect(fresh.currentTier?.rank).toBe(1); // threshold-0 tier applies from day one
    expect(fresh.nextTier?.rank).toBe(2);

    const code = (await h.call(m.user, "POST", `/v1/me/organizations/${s.org}/connection-codes`, { locationId: s.l1 })).body.code;
    const res = await h.call(s.cashier, "POST", `/v1/organizations/${s.org}/locations/${s.l1}/connection-codes/lookup`, { code, terminalId: "t1", idempotencyKey: key() });
    expect(res.status).toBe(200);
    const assoc = await h.call(s.cashier, "POST", `/v1/organizations/${s.org}/locations/${s.l1}/connection-reservations/${res.body.reservationId}/associate`,
      { method: "order_reference", provider: "fixture", externalOrderId: "flow-order-1", idempotencyKey: key() });
    expect(assoc.status, JSON.stringify(assoc.body)).toBe(201);
    // Associated but the POS has not confirmed: no points, wallet says updates are pending.
    expect(await wallet(m.user)).toMatchObject({ availablePoints: 0, dataStatus: "pending_updates" });
    const pendingFeed = (await h.call(m.user, "GET", `/v1/me/organizations/${s.org}/activity`)).body.items as ActivityItem[];
    expect(pendingFeed[0]).toMatchObject({ kind: "purchase_pending", points: 0 });

    await h.admin.query(
      `insert into togiva.pos_transactions (organization_id, location_id, pos_connection_id, provider_code, external_transaction_id, external_order_id,
         currency, subtotal_minor, tax_minor, total_minor, status, purchased_at)
       values ($1, $2, $3, 'fixture', 'flow-txn-1', 'flow-order-1', 'USD', 1299, 104, 1403, 'paid', now())`, [s.org, s.l1, s.pos]);
    await runJobs();
    const w = await wallet(m.user);
    expect(w).toMatchObject({ availablePoints: 12, pendingPoints: 0, dataStatus: "current" });
    expect(w.currentTier?.rank).toBe(1);
    expect(w.qualification).toMatchObject({ metric: "qualifying_spend", progress: 1299, nextThreshold: 5000 });
    const feed = (await h.call(m.user, "GET", `/v1/me/organizations/${s.org}/activity`)).body.items as ActivityItem[];
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ kind: "purchase_earned", points: 12, bonusPoints: 0, eligibleAmount: { amountMinor: 1299, currency: "USD" }, location: { id: s.l1, name: "Store One" } });
  });

  it("is idempotent when the earning job runs again", async () => {
    const m = await member();
    const { associationId, txnId } = await purchase(s.org, m.oc, 2000);
    await h.admin.query("select togiva.enqueue_job('loyalty.process_association', $1::jsonb, $2, 'replay-1')", [JSON.stringify({ associationId, posTransactionId: txnId }), s.org]);
    await runJobs();
    expect((await wallet(m.user)).availablePoints).toBe(20);
  });

  it("applies location bonuses and promotes tiers, then earns at the new tier's multiplier", async () => {
    const m = await member();
    await purchase(s.org, m.oc, 1000, s.l2);
    expect((await wallet(m.user)).availablePoints).toBe(15);
    await purchase(s.org, m.oc, 4000);
    const w = await wallet(m.user);
    expect(w.currentTier?.rank).toBe(2);
    expect(w.nextTier).toBeNull();
    await purchase(s.org, m.oc, 1000);
    expect((await wallet(m.user)).availablePoints).toBe(15 + 40 + 20);
  });

  it("holds points as pending during the program's refund window", async () => {
    const org = await h.fixtures.organization();
    const loc = await h.fixtures.location(org);
    const pos = await h.fixtures.posConnection(org);
    const p = await createProgram(org, { pendingPeriodSeconds: 3600 });
    await addRule(org, p.versionId, { type: "base_rate", pointsPerUnit: 1 });
    const m = await member(org);
    await purchase(org, m.oc, 800, loc, pos);
    expect(await wallet(m.user, org)).toMatchObject({ availablePoints: 0, pendingPoints: 8 });
    const feed = (await h.call(m.user, "GET", `/v1/me/organizations/${org}/activity`)).body.items as ActivityItem[];
    expect(feed[0]).toMatchObject({ kind: "purchase_pending", points: 8 });
  });
});

describe("refunds and voids", () => {
  it("appends compensating entries and never edits the original", async () => {
    const m = await member();
    const { txnId } = await purchase(s.org, m.oc, 3000);
    expect((await wallet(m.user)).availablePoints).toBe(30);
    await h.admin.query("update togiva.pos_transactions set status = 'partially_refunded', refunded_minor = 1000 where id = $1", [txnId]);
    await runJobs();
    expect((await wallet(m.user)).availablePoints).toBe(20);
    // The same POS update delivered twice changes nothing.
    await h.admin.query("update togiva.pos_transactions set status = 'paid' where id = $1", [txnId]);
    await h.admin.query("update togiva.pos_transactions set status = 'partially_refunded' where id = $1", [txnId]);
    await runJobs();
    expect((await wallet(m.user)).availablePoints).toBe(20);
    await h.admin.query("update togiva.pos_transactions set status = 'voided' where id = $1", [txnId]);
    await runJobs();
    const w = await wallet(m.user);
    expect(w.availablePoints).toBe(0);
    expect(w.qualification.progress).toBe(0);
    const ledger = await h.admin.query("select entry_type, points from togiva.loyalty_ledger where source_id = $1 order by id", [txnId]);
    expect(ledger.rows).toEqual([{ entry_type: "earn", points: "30" }, { entry_type: "refund_reversal", points: "-10" }, { entry_type: "void_reversal", points: "-20" }]);
    const feed = (await h.call(m.user, "GET", `/v1/me/organizations/${s.org}/activity`)).body.items as ActivityItem[];
    expect(feed.map((f) => f.description)).toEqual(["Purchase voided", "Purchase refunded", "Purchase"]);
  });
});

describe("rewards and redemption", () => {
  it("lists rewards with server-side eligibility", async () => {
    const m = await member();
    await purchase(s.org, m.oc, 2500);
    const cheap = await addReward({ cost: 10, name: "Cheap" });
    const tiered = await addReward({ cost: 5, name: "Tiered", minTierRank: 2 });
    const elsewhere = await addReward({ cost: 1, name: "Elsewhere", locations: [s.l2] });
    const r = await h.call(m.user, "GET", `/v1/me/organizations/${s.org}/rewards?locationId=${s.l1}&limit=200`);
    expect(r.status).toBe(200);
    const byId = new Map((r.body.items as { id: string; eligibility: { reasons: string[] } }[]).map((i) => [i.id, i.eligibility.reasons]));
    expect(byId.get(cheap)).toEqual([]);
    expect(byId.get(tiered)).toEqual(["tier_required"]);
    expect(byId.get(elsewhere)).toEqual(["not_available_at_location"]);
  });

  it("debits on issue, completes exactly once at the right store, and replays idempotently", async () => {
    const m = await member();
    await purchase(s.org, m.oc, 3000);
    const reward = await addReward({ cost: 20, name: "Free Fries", stock: 5 });
    const idem = key();
    const issued = await h.call(m.user, "POST", `/v1/me/organizations/${s.org}/redemptions`, { rewardId: reward, locationId: s.l1, idempotencyKey: idem });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    const red = IssuedRedemption.parse(issued.body);
    expect(red.token).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect((await wallet(m.user)).availablePoints).toBe(10);
    const stored = await h.admin.query("select * from togiva.reward_redemptions where id = $1", [red.id]);
    expect(JSON.stringify(stored.rows[0])).not.toContain(red.token);

    const replay = await h.call(m.user, "POST", `/v1/me/organizations/${s.org}/redemptions`, { rewardId: reward, locationId: s.l1, idempotencyKey: idem });
    expect(replay.status).toBe(200);
    expect(replay.body.token).toBe(red.token);
    expect((await wallet(m.user)).availablePoints).toBe(10);
    expect((await h.call(m.user, "GET", `/v1/me/organizations/${s.org}/redemptions/${red.id}`)).body.token).toBe(red.token);

    expect((await h.call(s.cashier2, "POST", redeemPath(s.l2, "verify"), { token: red.token })).body.error.code).toBe("redemption_wrong_location");
    expect((await h.call(s.cashier2, "POST", redeemPath(s.l1, "verify"), { token: red.token })).status).toBe(403);
    const v = await h.call(s.cashier, "POST", redeemPath(s.l1, "verify"), { token: red.token.toLowerCase().replace(/-/g, " ") });
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ status: "issued", reward: { name: "Free Fries" }, customer: { firstName: "Casey" } });
    expect(v.body.customer.membershipLast4).toHaveLength(4);

    const [a, b] = await Promise.all([
      h.call(s.cashier, "POST", redeemPath(s.l1, "complete"), { token: red.token, terminalId: "t1" }),
      h.call(s.cashier, "POST", redeemPath(s.l1, "complete"), { token: red.token, terminalId: "t2" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await h.call(m.user, "DELETE", `/v1/me/organizations/${s.org}/redemptions/${red.id}`)).body.error.code).toBe("redemption_already_completed");
    const inv = await h.admin.query("select quantity_reserved, quantity_redeemed from togiva.reward_inventory where reward_id = $1", [reward]);
    expect(inv.rows[0]).toEqual({ quantity_reserved: 0, quantity_redeemed: 1 });
    expect((await h.call(s.cashier, "POST", redeemPath(s.l1, "verify"), { token: "ZZZZ-ZZZZ-ZZZZ-ZZZZ" })).body.error.code).toBe("redemption_invalid");
  });

  it("refuses when points are short, and returns points on cancel or expiry", async () => {
    const m = await member();
    await purchase(s.org, m.oc, 1500);
    const big = await addReward({ cost: 500 });
    expect((await h.call(m.user, "POST", `/v1/me/organizations/${s.org}/redemptions`, { rewardId: big, locationId: s.l1, idempotencyKey: key() })).body.error.code).toBe("insufficient_points");

    const small = await addReward({ cost: 10 });
    const one = (await h.call(m.user, "POST", `/v1/me/organizations/${s.org}/redemptions`, { rewardId: small, locationId: s.l1, idempotencyKey: key() })).body;
    expect((await wallet(m.user)).availablePoints).toBe(5);
    expect((await h.call(m.user, "DELETE", `/v1/me/organizations/${s.org}/redemptions/${one.id}`)).status).toBe(204);
    expect((await wallet(m.user)).availablePoints).toBe(15);

    const two = (await h.call(m.user, "POST", `/v1/me/organizations/${s.org}/redemptions`, { rewardId: small, locationId: s.l1, idempotencyKey: key() })).body;
    await h.admin.query("update togiva.reward_redemptions set expires_at = now() - interval '1 second' where id = $1", [two.id]);
    expect((await h.call(s.cashier, "POST", redeemPath(s.l1, "complete"), { token: two.token })).body.error.code).toBe("redemption_expired");
    await h.admin.query("select togiva.enqueue_job('loyalty.redemptions.sweep', '{}'::jsonb, null, $1)", [key()]);
    await runJobs();
    expect((await wallet(m.user)).availablePoints).toBe(15);
    const mine = (await h.call(m.user, "GET", `/v1/me/organizations/${s.org}/redemptions`)).body.items as { id: string; status: string }[];
    expect(mine.map((x) => x.status)).toEqual(["expired", "cancelled"]);

    const other = await member();
    expect((await h.call(other.user, "GET", `/v1/me/organizations/${s.org}/redemptions/${two.id}`)).status).toBe(404);
  });
});

describe("adjustments", () => {
  it("needs a second person to approve before the balance changes", async () => {
    const m = await member();
    const req = await h.call(s.gm, "POST", `/v1/organizations/${s.org}/locations/${s.l1}/loyalty/adjustments`, { organizationCustomerId: m.oc, points: 15, reason: "Missed scan on receipt 1234" });
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    expect(req.body).toMatchObject({ status: "pending", locationId: s.l1 });
    expect((await wallet(m.user)).availablePoints).toBe(0);
    // Store staff without loyalty.adjust.request, and managers without approve rights, are refused.
    expect((await h.call(s.cashier, "POST", `/v1/organizations/${s.org}/locations/${s.l1}/loyalty/adjustments`, { organizationCustomerId: m.oc, points: 5, reason: "trying it" })).status).toBe(403);
    expect((await h.call(s.gm, "POST", `/v1/organizations/${s.org}/loyalty/adjustments/${req.body.id}/decision`, { decision: "approve" })).status).toBe(403);

    const approved = await h.call(s.admin1, "POST", `/v1/organizations/${s.org}/loyalty/adjustments/${req.body.id}/decision`, { decision: "approve" });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: "applied", reviewedBy: s.admin1 });
    expect((await wallet(m.user)).availablePoints).toBe(15);
    expect((await h.call(s.admin2, "POST", `/v1/organizations/${s.org}/loyalty/adjustments/${req.body.id}/decision`, { decision: "reject" })).body.error.code).toBe("conflict");

    const own = await h.call(s.admin1, "POST", `/v1/organizations/${s.org}/loyalty/adjustments`, { organizationCustomerId: m.oc, points: -100, reason: "Self-approval attempt" });
    expect((await h.call(s.admin1, "POST", `/v1/organizations/${s.org}/loyalty/adjustments/${own.body.id}/decision`, { decision: "approve" })).status).toBe(403);
    expect((await h.call(s.admin2, "POST", `/v1/organizations/${s.org}/loyalty/adjustments/${own.body.id}/decision`, { decision: "approve" })).body.error.code).toBe("insufficient_points");
    const list = await h.call(s.admin2, "GET", `/v1/organizations/${s.org}/loyalty/adjustments?status=pending`);
    expect(list.body.items.map((i: { id: string }) => i.id)).toContain(own.body.id);
    const feed = (await h.call(m.user, "GET", `/v1/me/organizations/${s.org}/activity`)).body.items as ActivityItem[];
    expect(feed[0]).toMatchObject({ kind: "adjustment", points: 15, description: "Points adjustment" });
  });
});

describe("ledger reconciliation", () => {
  it("rebuilds drifted balance projections and records the drift", async () => {
    const m = await member();
    await purchase(s.org, m.oc, 1000);
    await h.admin.query("update togiva.loyalty_balance_projections p set available_points = 999 from togiva.loyalty_accounts a where a.id = p.loyalty_account_id and a.organization_customer_id = $1", [m.oc]);
    await h.admin.query("select togiva.enqueue_job('loyalty.reconcile', '{}'::jsonb, null, $1)", [key()]);
    await runJobs();
    const p = await h.admin.query("select available_points from togiva.loyalty_balance_projections p join togiva.loyalty_accounts a on a.id = p.loyalty_account_id where a.organization_customer_id = $1", [m.oc]);
    expect(p.rows[0].available_points).toBe("10");
    const errs = await h.admin.query("select count(*)::int as n from togiva.integration_errors where error_code = 'loyalty_projection_drift'");
    expect(errs.rows[0].n).toBe(1);
  });

  it("keeps the ledger append-only", async () => {
    await expect(h.admin.query("update togiva.loyalty_ledger set points = points + 1")).rejects.toThrow(/append-only/);
  });
});
