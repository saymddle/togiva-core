import { Database } from "@togiva/database";
import { coreJobHandlers } from "./modules/jobs/handlers.js";
import { JobWorker } from "./modules/jobs/queue.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = new Database({ connectionString: url, max: 4, applicationName: "togiva-worker" });
const worker = new JobWorker(db, coreJobHandlers);
let running = true;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { running = false; });

let lastSweep = 0;
while (running) {
  // Periodic sweep, deduplicated across workers by a per-minute idempotency key.
  if (Date.now() - lastSweep > 60_000) {
    lastSweep = Date.now();
    const minute = Math.floor(Date.now() / 60_000);
    const hour = Math.floor(minute / 60);
    await db.asService({ userId: null }, async (tx) => {
      await tx.query("select togiva.enqueue_job('connection_codes.sweep', '{}'::jsonb, null, $1)", [`sweep:${minute}`]);
      await tx.query("select togiva.enqueue_job('loyalty.redemptions.sweep', '{}'::jsonb, null, $1)", [`sweep:${minute}`]);
      await tx.query("select togiva.enqueue_job('loyalty.reconcile', '{}'::jsonb, null, $1)", [`reconcile:${hour}`]);
    });
  }
  const n = await worker.runOnce().catch((err) => { console.error("worker batch failed", err); return 0; });
  if (n === 0) await new Promise((r) => setTimeout(r, 1000));
}
await db.close();
