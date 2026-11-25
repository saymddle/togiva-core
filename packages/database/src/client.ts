import pg from "pg";

export type Queryable = Pick<pg.PoolClient, "query">;

export interface DbConfig {
  connectionString: string;
  /** Max pool size. Behind Supabase, point this at the transaction pooler (port 6543). */
  max?: number;
  applicationName?: string;
}

export interface RequestContext {
  /** Authenticated user id (identity provider subject). Null for anonymous calls. */
  userId: string | null;
  requestId?: string | null;
}

/**
 * Database access for TOGIVA Core.
 *
 * Two execution modes, both transactional:
 *  - `asUser(ctx, fn)`: SET LOCAL ROLE togiva_app and set the request context.
 *    Row-level security applies. Use for every request-scoped read and for
 *    writes whose policies are defined in 0009_row_level_security.sql.
 *  - `asService(ctx, fn)`: SET LOCAL ROLE togiva_service (BYPASSRLS). Only for
 *    trusted domain services after authorization in code, and for workers.
 *
 * The login role in DATABASE_URL must be a member of both roles
 * (`grant togiva_app, togiva_service to <login>`), see docs/DATABASE.md.
 */
export class Database {
  readonly pool: pg.Pool;

  constructor(config: DbConfig) {
    this.pool = new pg.Pool({
      connectionString: config.connectionString,
      max: config.max ?? 10,
      application_name: config.applicationName ?? "togiva-core",
    });
  }

  async asUser<T>(ctx: RequestContext, fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.transaction("togiva_app", ctx, fn);
  }

  async asService<T>(ctx: RequestContext, fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.transaction("togiva_service", ctx, fn);
  }

  private async transaction<T>(role: "togiva_app" | "togiva_service", ctx: RequestContext, fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(`set local role ${role}`);
      await client.query("select togiva.set_request_context($1::uuid, $2::text)", [ctx.userId, ctx.requestId ?? null]);
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Postgres error code helpers used across services. */
export const PgErrorCode = {
  uniqueViolation: "23505",
  foreignKeyViolation: "23503",
  checkViolation: "23514",
  insufficientPrivilege: "42501",
  raiseException: "P0001",
} as const;

export function isPgError(err: unknown, code?: string): err is pg.DatabaseError {
  return typeof err === "object" && err !== null && "code" in err && (code === undefined || (err as { code: string }).code === code);
}
