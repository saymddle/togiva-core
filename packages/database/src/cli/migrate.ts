import { migrate } from "../migrations.js";

const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_MIGRATION_URL or DATABASE_URL is required");
  process.exit(1);
}
const applied = await migrate(url, { log: (m) => console.log(m) });
console.log(applied.length ? `applied ${applied.length} migration(s)` : "database is up to date");
