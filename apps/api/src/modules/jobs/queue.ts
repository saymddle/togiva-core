import { hostname } from "node:os";
import type { Database, Queryable } from "@togiva/database";

export interface Job {
  id: number;
  organizationId: string | null;
  jobType: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

/** A handler runs inside one service-role transaction; throwing rolls back its writes. */
export type JobHandler = (tx: Queryable, job: Job) => Promise<void>;

/** Throw to retry later without treating it as an error (e.g. waiting for a webhook). */
export class RetryLater extends Error {}

export const backoffSeconds = (attempt: number) => Math.min(3600, 15 * 2 ** Math.max(0, attempt - 1));

/**
 * Postgres-backed durable job queue (background_jobs). Claims with
 * FOR UPDATE SKIP LOCKED so many workers can run safely. A worker only claims
 * job types it has handlers for; others wait for a worker that does. Jobs that
 * exhaust attempts become 'dead' and are recorded in integration_errors for
 * alerting, never dropped.
 */
export class JobWorker {
  readonly workerId = `${hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;

  constructor(private readonly db: Database, private readonly handlers: Record<string, JobHandler>, private readonly opts: { batchSize?: number; stuckAfterSeconds?: number } = {}) {}

  /** Claims and runs one batch. Returns the number of jobs processed. */
  async runOnce(): Promise<number> {
    const types = Object.keys(this.handlers);
    const jobs = await this.db.asService({ userId: null }, async (tx) => {
      await tx.query(
        `update togiva.background_jobs set status = 'failed', locked_by = null, last_error = 'worker lease expired'
          where status = 'running' and locked_at < now() - make_interval(secs => $1)`,
        [this.opts.stuckAfterSeconds ?? 900],
      );
      const r = await tx.query<{ id: string; organization_id: string | null; job_type: string; payload: unknown; attempts: number; max_attempts: number }>(
        `update togiva.background_jobs j set status = 'running', locked_by = $3, locked_at = now(), attempts = attempts + 1
          where j.id in (select id from togiva.background_jobs
                          where status in ('pending', 'failed') and run_at <= now() and job_type = any($1)
                          order by priority desc, run_at limit $2 for update skip locked)
          returning j.id, j.organization_id, j.job_type, j.payload, j.attempts, j.max_attempts`,
        [types, this.opts.batchSize ?? 10, this.workerId],
      );
      return r.rows.map((row) => ({ id: Number(row.id), organizationId: row.organization_id, jobType: row.job_type, payload: row.payload, attempts: row.attempts, maxAttempts: row.max_attempts }));
    });
    for (const job of jobs) await this.execute(job);
    return jobs.length;
  }

  private async execute(job: Job): Promise<void> {
    try {
      await this.db.asService({ userId: null, requestId: `job:${job.id}` }, (tx) => this.handlers[job.jobType]!(tx, job));
      await this.db.asService({ userId: null }, (tx) =>
        tx.query("update togiva.background_jobs set status = 'succeeded', completed_at = now(), locked_by = null, last_error = null where id = $1", [job.id]));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const dead = job.attempts >= job.maxAttempts;
      await this.db.asService({ userId: null }, async (tx) => {
        await tx.query(
          `update togiva.background_jobs set status = $2, locked_by = null, last_error = $3,
                  run_at = now() + make_interval(secs => $4) where id = $1`,
          [job.id, dead ? "dead" : "failed", message.slice(0, 2000), backoffSeconds(job.attempts)],
        );
        if (dead) {
          await tx.query(
            `insert into togiva.integration_errors (organization_id, source, error_code, message, details)
             values ($1, 'background_jobs', 'job_dead', $2, $3)`,
            [job.organizationId, `Job ${job.jobType} exhausted ${job.attempts} attempts`, JSON.stringify({ jobId: job.id, lastError: message.slice(0, 500) })],
          );
        }
      });
    }
  }
}
