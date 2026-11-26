import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

const APP_ORIGIN = "https://customer.example.test";
let h: Harness;
let orgId: string;

beforeAll(async () => {
  h = await createHarness({ corsAllowedOrigins: [APP_ORIGIN] });
  orgId = await h.fixtures.organization({ slug: "slug-org", name: "Slug Org" });
  const other = await h.fixtures.organization({ slug: "suspended-org", name: "Suspended Org" });
  await h.admin.query("update togiva.organizations set status = 'suspended' where id = $1", [other]);
});
afterAll(async () => h?.close());

describe("GET /v1/organizations/by-slug/{slug}", () => {
  it("resolves an active organization without authentication and returns only the public summary", async () => {
    const r = await h.call(null, "GET", "/v1/organizations/by-slug/slug-org");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: orgId, slug: "slug-org", name: "Slug Org", status: "active", defaultCurrency: "USD", defaultTimezone: expect.any(String) });
  });
  it("does not reveal organizations that are not active", async () => {
    expect((await h.call(null, "GET", "/v1/organizations/by-slug/suspended-org")).status).toBe(404);
  });
  it("returns 404 for unknown slugs and rejects malformed ones", async () => {
    expect((await h.call(null, "GET", "/v1/organizations/by-slug/nope-nope")).status).toBe(404);
    expect((await h.call(null, "GET", "/v1/organizations/by-slug/Bad_Slug")).status).toBe(400);
  });
});

describe("CORS", () => {
  it("allows configured origins on normal requests", async () => {
    const r = await h.app.inject({ method: "GET", url: "/v1/health", headers: { origin: APP_ORIGIN } });
    expect(r.headers["access-control-allow-origin"]).toBe(APP_ORIGIN);
    expect(r.headers["access-control-allow-credentials"]).toBeUndefined();
  });
  it("answers preflight for configured origins, including on authenticated routes", async () => {
    const r = await h.app.inject({
      method: "OPTIONS", url: "/v1/me",
      headers: { origin: APP_ORIGIN, "access-control-request-method": "GET", "access-control-request-headers": "authorization" },
    });
    expect(r.statusCode).toBe(204);
    expect(r.headers["access-control-allow-origin"]).toBe(APP_ORIGIN);
    expect(String(r.headers["access-control-allow-headers"])).toContain("authorization");
  });
  it("sends no CORS headers to other origins", async () => {
    const r = await h.app.inject({ method: "GET", url: "/v1/health", headers: { origin: "https://evil.example.test" } });
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    const pre = await h.app.inject({ method: "OPTIONS", url: "/v1/me", headers: { origin: "https://evil.example.test", "access-control-request-method": "GET" } });
    expect(pre.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
