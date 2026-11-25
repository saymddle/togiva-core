import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { MIGRATIONS_DIR } from "../migrations.js";

// Development fixtures only. Refuses to run when NODE_ENV=production.
if (process.env.NODE_ENV === "production") {
  console.error("refusing to load development fixtures in production");
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query(await readFile(join(MIGRATIONS_DIR, "..", "seeds", "dev", "fixtures.sql"), "utf8"));
await client.end();
console.log("loaded development fixtures (fixture organization, not real business data)");
