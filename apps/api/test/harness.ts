import { randomBytes } from "node:crypto";
import { SignJWT } from "jose";
import type { Database } from "@togiva/database";
import { createTestDatabase, Fixtures } from "@togiva/database/test-utils";
import { buildApp } from "../src/app.js";
import { JwtIdentityVerifier } from "../src/auth/verifier.js";
import { ConnectionCodeHasher } from "../src/modules/connection-codes/crypto.js";
import { coreJobHandlers } from "../src/modules/jobs/handlers.js";
import { JobWorker } from "../src/modules/jobs/queue.js";

const JWT_SECRET = randomBytes(32).toString("hex");

export async function createHarness() {
  const t = await createTestDatabase();
  const hasher = new ConnectionCodeHasher(new Map([[1, randomBytes(32)]]), 1);
  const app = buildApp({ db: t.db, verifier: new JwtIdentityVerifier({ jwtSecret: JWT_SECRET, audience: "authenticated" }), hasher });
  await app.ready();
  const fixtures = new Fixtures(t.admin);

  const token = (userId: string, email = `${userId}@example.test`) =>
    new SignJWT({ email, user_metadata: { email_verified: true } })
      .setProtectedHeader({ alg: "HS256" }).setSubject(userId).setAudience("authenticated").setIssuedAt().setExpirationTime("10m")
      .sign(new TextEncoder().encode(JWT_SECRET));

  const call = async (userId: string | null, method: string, url: string, payload?: unknown) => {
    const headers: Record<string, string> = userId ? { authorization: `Bearer ${await token(userId)}` } : {};
    const res = await app.inject({ method: method as "GET", url, headers, payload: payload as object });
    return { status: res.statusCode, body: res.body ? res.json() : undefined, headers: res.headers };
  };

  return {
    app, db: t.db as Database, admin: t.admin, fixtures, hasher, call, token,
    worker: new JobWorker(t.db, coreJobHandlers),
    close: async () => { await app.close(); await t.drop(); },
  };
}
export type Harness = Awaited<ReturnType<typeof createHarness>>;
