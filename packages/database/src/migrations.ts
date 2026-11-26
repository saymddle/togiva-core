import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  return Promise.all(
    files.map(async (file) => {
      const sql = await readFile(join(dir, file), "utf8");
      return {
        version: file.slice(0, 4),
        name: file.replace(/\.sql$/, ""),
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
}

/**
 * Forward-only migration runner. Each file runs in its own transaction and is
 * recorded with a checksum; editing an applied migration is an error (write a
 * new migration instead). A session advisory lock prevents concurrent runs.
 */
export async function migrate(connectionString: string, opts: { log?: (msg: string) => void; dir?: string } = {}): Promise<string[]> {
  const log = opts.log ?? (() => undefined);
  const client = new pg.Client({ connectionString, application_name: "togiva-migrate" });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query("select pg_advisory_lock(hashtext('togiva.migrations'))");
    await client.query(`create table if not exists public.togiva_schema_migrations (
      version text primary key, name text not null, checksum text not null, applied_at timestamptz not null default now())`);
    const { rows } = await client.query<{ version: string; checksum: string }>("select version, checksum from public.togiva_schema_migrations");
    const done = new Map(rows.map((r) => [r.version, r.checksum]));
    for (const m of await loadMigrations(opts.dir)) {
      const prior = done.get(m.version);
      if (prior) {
        if (prior !== m.checksum) throw new Error(`Migration ${m.name} was modified after being applied. Add a new migration instead.`);
        continue;
      }
      log(`applying ${m.name}`);
      await client.query("begin");
      try {
        await client.query(m.sql);
        await client.query("insert into public.togiva_schema_migrations (version, name, checksum) values ($1, $2, $3)", [m.version, m.name, m.checksum]);
        await client.query("commit");
      } catch (err) {
        await client.query("rollback");
        throw new Error(`Migration ${m.name} failed: ${(err as Error).message}`);
      }
      applied.push(m.name);
    }
  } finally {
    await client.query("select pg_advisory_unlock(hashtext('togiva.migrations'))").catch(() => undefined);
    await client.end();
  }
  return applied;
}
