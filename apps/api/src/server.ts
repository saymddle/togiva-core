import { Database } from "@togiva/database";
import { buildApp } from "./app.js";
import { JwtIdentityVerifier } from "./auth/verifier.js";
import { loadConfig } from "./config.js";
import { ConnectionCodeHasher } from "./modules/connection-codes/crypto.js";

const config = loadConfig();
const db = new Database({ connectionString: config.databaseUrl, max: config.databasePoolMax, applicationName: "togiva-api" });
const app = buildApp({
  db,
  verifier: new JwtIdentityVerifier(config.auth),
  hasher: new ConnectionCodeHasher(config.connectionCodes.keys, config.connectionCodes.activeKeyVersion),
  version: process.env.APP_VERSION,
  logger: { level: config.logLevel, redact: ["req.headers.authorization"] },
  trustProxy: config.trustProxy,
});
await app.listen({ port: config.port, host: "0.0.0.0" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    await db.close();
    process.exit(0);
  });
}
