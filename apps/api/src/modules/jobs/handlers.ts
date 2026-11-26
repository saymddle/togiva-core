import { reconcileAssociation } from "../connection-codes/reconcile.js";
import { reconcileLedger } from "../loyalty/adjustments.js";
import { processAssociation, processTransactionChange } from "../loyalty/earning.js";
import { sweepExpiredRedemptions } from "../loyalty/redemptions.js";
import type { JobHandler } from "./queue.js";

/** Expires stale codes and lapsed reservations across all locations. */
const sweepConnectionCodes: JobHandler = async (tx) => {
  await tx.query("select togiva.expire_stale_connection_codes(null)");
};

/** Handlers this release of TOGIVA Core can run. Later phases add theirs here. */
export const coreJobHandlers: Record<string, JobHandler> = {
  "connection_codes.sweep": sweepConnectionCodes,
  "connection_association.reconcile": reconcileAssociation,
  "loyalty.process_association": processAssociation,
  "loyalty.process_transaction_change": processTransactionChange,
  "loyalty.redemptions.sweep": sweepExpiredRedemptions,
  "loyalty.reconcile": reconcileLedger,
};
