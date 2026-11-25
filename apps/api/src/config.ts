import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().default(10),
  /** HS256 shared secret (Supabase "JWT secret"), or use AUTH_JWKS_URL for asymmetric keys. */
  AUTH_JWT_SECRET: z.string().min(32).optional(),
  AUTH_JWKS_URL: z.url().optional(),
  AUTH_ISSUER: z.string().optional(),
  AUTH_AUDIENCE: z.string().default("authenticated"),
  /**
   * Versioned HMAC keys for connection-code lookup hashes: "1:<base64>,2:<base64>".
   * Each key must decode to at least 32 bytes. Never exposed to clients.
   */
  CONNECTION_CODE_HMAC_KEYS: z.string().min(1),
  CONNECTION_CODE_ACTIVE_KEY_VERSION: z.coerce.number().int().positive().default(1),
  TRUST_PROXY: z.coerce.boolean().default(false),
  LOG_LEVEL: z.string().default("info"),
});
export type Env = z.infer<typeof Env>;

export interface AppConfig {
  env: Env["NODE_ENV"];
  port: number;
  databaseUrl: string;
  databasePoolMax: number;
  auth: { jwtSecret?: string; jwksUrl?: string; issuer?: string; audience: string };
  connectionCodes: { keys: Map<number, Buffer>; activeKeyVersion: number };
  trustProxy: boolean;
  logLevel: string;
}

export function parseHmacKeys(spec: string): Map<number, Buffer> {
  const keys = new Map<number, Buffer>();
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [v, b64] = part.split(":");
    const version = Number(v);
    if (!Number.isInteger(version) || version <= 0 || !b64) throw new Error("CONNECTION_CODE_HMAC_KEYS must look like 1:<base64>");
    const key = Buffer.from(b64, "base64");
    if (key.length < 32) throw new Error(`connection code HMAC key ${version} must be at least 32 bytes`);
    keys.set(version, key);
  }
  return keys;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const env = Env.parse(source);
  if (!env.AUTH_JWT_SECRET && !env.AUTH_JWKS_URL) throw new Error("Set AUTH_JWT_SECRET or AUTH_JWKS_URL");
  const keys = parseHmacKeys(env.CONNECTION_CODE_HMAC_KEYS);
  if (!keys.has(env.CONNECTION_CODE_ACTIVE_KEY_VERSION)) throw new Error("CONNECTION_CODE_ACTIVE_KEY_VERSION has no matching key");
  return {
    env: env.NODE_ENV,
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    databasePoolMax: env.DATABASE_POOL_MAX,
    auth: { jwtSecret: env.AUTH_JWT_SECRET, jwksUrl: env.AUTH_JWKS_URL, issuer: env.AUTH_ISSUER, audience: env.AUTH_AUDIENCE },
    connectionCodes: { keys, activeKeyVersion: env.CONNECTION_CODE_ACTIVE_KEY_VERSION },
    trustProxy: env.TRUST_PROXY,
    logLevel: env.LOG_LEVEL,
  };
}
