import type { Queryable } from "@togiva/database";
import { RetryLater, type JobHandler } from "../jobs/queue.js";

/** How long an association may wait for the POS sale before it goes to human review. */
export const ASSOCIATION_REVIEW_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Matches a pending association to its POS transaction once the POS pipeline
 * has ingested it (webhook or sync). Outcomes:
 *  - paid / partially refunded / refunded -> confirmed (loyalty engine decides points and reversals)
 *  - voided  -> rejected (a voided sale never earns)
 *  - not yet ingested -> retry with backoff; after 24h -> needs_review plus an
 *    integration error, so a purchase is never silently lost.
 * Runs as togiva_service inside the worker.
 */
export const reconcileAssociation: JobHandler = async (tx: Queryable, job) => {
  const { associationId } = job.payload as { associationId: string };
  const a = await tx.query<{
    id: string; organization_id: string; location_id: string; organization_customer_id: string; status: string; provider_code: string;
    external_order_id: string | null; external_transaction_id: string | null; pos_transaction_id: string | null; created_at: Date;
  }>("select * from togiva.customer_transaction_associations where id = $1 for update", [associationId]);
  const assoc = a.rows[0];
  if (!assoc || assoc.status !== "pending_pos_confirmation") return;

  const t = await tx.query<{ id: string; status: string; location_id: string }>(
    `select id, status, location_id from togiva.pos_transactions
      where organization_id = $1 and provider_code = $2 and (
        id = $3 or ($4::text is not null and external_transaction_id = $4) or ($5::text is not null and external_order_id = $5))
      order by purchased_at desc limit 1`,
    [assoc.organization_id, assoc.provider_code, assoc.pos_transaction_id, assoc.external_transaction_id, assoc.external_order_id],
  );
  const txn = t.rows[0];
  const event = (type: string, reason?: string) =>
    tx.query(
      `insert into togiva.customer_connection_events (organization_id, location_id, organization_customer_id, association_id, event_type, reason)
       values ($1, $2, $3, $4, $5, $6)`,
      [assoc.organization_id, assoc.location_id, assoc.organization_customer_id, assoc.id, type, reason ?? null],
    );

  if (!txn) {
    if (Date.now() - assoc.created_at.getTime() > ASSOCIATION_REVIEW_AFTER_MS) {
      await tx.query("update togiva.customer_transaction_associations set status = 'needs_review', status_reason = 'pos_transaction_not_received' where id = $1", [assoc.id]);
      await tx.query(
        `insert into togiva.integration_errors (organization_id, location_id, source, error_code, message, details)
         values ($1, $2, 'connection_association', 'pos_transaction_not_received', 'POS sale for a member association was not received within 24 hours', $3)`,
        [assoc.organization_id, assoc.location_id, JSON.stringify({ associationId: assoc.id })],
      );
      await event("association_needs_review", "pos_transaction_not_received");
      return;
    }
    throw new RetryLater("POS transaction not ingested yet");
  }
  if (txn.location_id !== assoc.location_id) {
    await tx.query("update togiva.customer_transaction_associations set status = 'needs_review', status_reason = 'location_mismatch', pos_transaction_id = $2 where id = $1", [assoc.id, txn.id]);
    await event("association_needs_review", "location_mismatch");
    return;
  }
  if (txn.status === "voided") {
    await tx.query("update togiva.customer_transaction_associations set status = 'rejected', status_reason = 'transaction_voided', pos_transaction_id = $2 where id = $1", [assoc.id, txn.id]);
    await event("association_rejected", "transaction_voided");
    return;
  }
  if (txn.status === "open") throw new RetryLater("POS order still open");

  // Another member already confirmed on this transaction -> human review, never double credit.
  try {
    await tx.query("savepoint confirm");
    await tx.query(
      "update togiva.customer_transaction_associations set status = 'confirmed', confirmed_at = now(), pos_transaction_id = $2, status_reason = null where id = $1",
      [assoc.id, txn.id],
    );
  } catch (err) {
    if ((err as { code?: string }).code !== "23505") throw err;
    await tx.query("rollback to savepoint confirm");
    await tx.query("update togiva.customer_transaction_associations set status = 'needs_review', status_reason = 'transaction_already_associated' where id = $1", [assoc.id]);
    await event("association_needs_review", "transaction_already_associated");
    return;
  }
  await event("association_confirmed");
  // Handed to the loyalty engine (Phase 4). The job waits durably until a
  // worker with a 'loyalty.process_association' handler is deployed.
  await tx.query("select togiva.enqueue_job('loyalty.process_association', $1::jsonb, $2, $3)", [
    JSON.stringify({ associationId: assoc.id, posTransactionId: txn.id }), assoc.organization_id, `loyalty-assoc:${assoc.id}`,
  ]);
};
