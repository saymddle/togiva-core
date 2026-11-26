import { randomBytes } from "node:crypto";
import pg from "pg";
import { Database } from "./client.js";
import { migrate } from "./migrations.js";
export { Fixtures } from "./fixtures.js";

/**
 * Creates an isolated, fully migrated database for a test file and returns a
 * Database handle plus a superuser client for fixture setup.
 * Requires TEST_DATABASE_URL pointing at a server where the user can CREATE DATABASE.
 */
export async function createTestDatabase(): Promise<{ db: Database; admin: pg.Client; url: string; drop: () => Promise<void> }> {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) throw new Error("TEST_DATABASE_URL is required for database tests (e.g. postgres://postgres@localhost:5432/postgres)");
  const name = `togiva_test_${randomBytes(6).toString("hex")}`;
  const root = new pg.Client({ connectionString: base });
  await root.connect();
  await root.query(`create database ${name}`);
  await root.end();
  const url = withDatabase(base, name);
  await migrate(url);
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  // The test login role must be able to SET ROLE to the runtime roles.
  await admin.query("grant togiva_app, togiva_service to current_user");
  const db = new Database({ connectionString: url, max: 8 });
  return {
    db,
    admin,
    url,
    drop: async () => {
      await db.close();
      await admin.end();
      const r = new pg.Client({ connectionString: base });
      await r.connect();
      await r.query(`drop database if exists ${name} with (force)`);
      await r.end();
    },
  };
}

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}
