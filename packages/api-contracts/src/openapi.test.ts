import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildOpenApi, CONTRACT_VERSION, v1Routes } from "./index.js";

describe("v1 contracts", () => {
  it("have unique ids and method+path pairs", () => {
    expect(new Set(v1Routes.map((r) => r.id)).size).toBe(v1Routes.length);
    expect(new Set(v1Routes.map((r) => `${r.method} ${r.path}`)).size).toBe(v1Routes.length);
  });
  it("require a permission on every staff route", () => {
    for (const r of v1Routes) if (r.auth === "staff") expect(r.permission, r.id).toBeDefined();
  });
  it("committed openapi/v1.json is up to date (run pnpm openapi)", () => {
    const committed = JSON.parse(readFileSync(join(__dirname, "..", "openapi", "v1.json"), "utf8"));
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildOpenApi(v1Routes, { version: CONTRACT_VERSION }))));
  });
});
