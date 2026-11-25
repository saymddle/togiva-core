import type { Database, Queryable } from "@togiva/database";
import { isPgError, PgErrorCode } from "@togiva/database";
import type {
  AssociateOrderRequest,
  ConnectionCodeReservation,
  ConnectionCodeState,
  IssuedConnectionCode,
  LookupConnectionCodeRequest,
  TransactionAssociation,
} from "@togiva/shared-types";
import { AppError } from "../../errors.js";
import { ConnectionCodeHasher, generateCode } from "./crypto.js";

type Ctx = { userId: string; requestId: string };

const MAX_GENERATION_ATTEMPTS = 25;

/**
 * Customer Connection Code Service.
 *
 * A temporary four-digit code that lets a cashier identify a member at the
 * counter. It identifies; it never authorizes. It cannot change an account,
 * pay, redeem, or award points. Points come only from POS-confirmed sales.
 *
 * All operations run as the request role (togiva_app) so row-level security
 * and the state-transition guard in 0009 apply in addition to the checks here.
 */
export class ConnectionCodeService {
  constructor(private readonly db: Database, private readonly hasher: ConnectionCodeHasher) {}

  // ------------------------------------------------------------------ customer

  async issue(ctx: Ctx, organizationId: string, locationId: string): Promise<IssuedConnectionCode> {
    return this.db.asUser(ctx, async (tx) => {
      const member = await this.requireMembership(tx, organizationId);
      const loc = await tx.query<{ name: string }>(
        "select name from togiva.locations where id = $1 and organization_id = $2 and status = 'active' and loyalty_participating",
        [locationId, organizationId],
      );
      if (!loc.rows[0]) throw new AppError("location_not_participating", "This location does not accept membership codes");
      const settings = await this.settings(tx, organizationId);

      // Serialize issuing per customer so "one active code" holds under concurrent taps.
      await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`cc-issue:${member.id}`]);
      const allowed = await tx.query<{ ok: boolean }>("select togiva.rate_limit_hit($1, $2, $3) as ok", [
        `cc-issue:${member.id}`, settings.failure_window_seconds, settings.issue_limit_per_window,
      ]);
      if (!allowed.rows[0]?.ok) throw new AppError("rate_limited", "Too many codes requested. Try again in a few minutes.", { retryAfterSeconds: settings.failure_window_seconds });

      // Replace any previous active code. A code already reserved by a cashier
      // is left alone so an in-progress checkout is not broken.
      const revoked = await tx.query<{ id: string; location_id: string }>(
        `update togiva.customer_connection_codes
            set status = 'revoked', revoked_at = now(),
                revoked_reason = case when location_id = $3 then 'replaced' else 'location_changed' end
          where organization_customer_id = $1 and organization_id = $2 and status = 'active'
          returning id, location_id`,
        [member.id, organizationId, locationId],
      );
      for (const r of revoked.rows) {
        await this.event(tx, { organizationId, locationId: r.location_id, codeId: r.id, customerId: member.id, type: "code_revoked", reason: r.location_id === locationId ? "replaced" : "location_changed", requestId: ctx.requestId, actor: ctx.userId });
      }

      await tx.query("select togiva.expire_stale_connection_codes($1)", [locationId]);

      for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
        const code = generateCode();
        const { hash, keyVersion } = this.hasher.issue(organizationId, locationId, code);
        await tx.query("savepoint cc_issue");
        try {
          const r = await tx.query<{ id: string; created_at: Date; expires_at: Date }>(
            `insert into togiva.customer_connection_codes (organization_id, organization_customer_id, location_id, code_hash, key_version, expires_at)
             values ($1, $2, $3, $4, $5, now() + make_interval(secs => $6)) returning id, created_at, expires_at`,
            [organizationId, member.id, locationId, hash, keyVersion, settings.code_ttl_seconds],
          );
          const row = r.rows[0]!;
          await this.event(tx, { organizationId, locationId, codeId: row.id, customerId: member.id, type: "code_issued", requestId: ctx.requestId, actor: ctx.userId });
          return {
            id: row.id,
            code,
            status: "active" as const,
            location: { id: locationId, name: loc.rows[0].name },
            issuedAt: row.created_at.toISOString(),
            expiresAt: row.expires_at.toISOString(),
            ttlSeconds: settings.code_ttl_seconds,
          };
        } catch (err) {
          // Same digits already live at this location: draw again.
          if (!isPgError(err, PgErrorCode.uniqueViolation)) throw err;
          await tx.query("rollback to savepoint cc_issue");
        }
      }
      throw new AppError("connection_code_space_exhausted", "Could not allocate a code right now. Please try again.");
    });
  }

  async current(ctx: Ctx, organizationId: string): Promise<ConnectionCodeState> {
    return this.db.asUser(ctx, async (tx) => {
      const member = await this.requireMembership(tx, organizationId);
      const r = await tx.query<{
        id: string; status: ConnectionCodeState["status"]; expires_at: Date; location_id: string; location_name: string;
        a_id: string | null; a_status: string | null; a_created: Date | null; a_confirmed: Date | null;
      }>(
        `select c.id, case when c.status = 'active' and c.expires_at <= now() then 'expired' else c.status end as status,
                c.expires_at, c.location_id, l.name as location_name,
                a.id as a_id, a.status as a_status, a.created_at as a_created, a.confirmed_at as a_confirmed
           from togiva.customer_connection_codes c
           join togiva.locations l on l.id = c.location_id
           left join togiva.customer_transaction_associations a on a.id = c.association_id
          where c.organization_customer_id = $1
          order by c.created_at desc limit 1`,
        [member.id],
      );
      const row = r.rows[0];
      if (!row) throw new AppError("not_found", "No connection code yet");
      return {
        id: row.id,
        status: row.status,
        location: { id: row.location_id, name: row.location_name },
        expiresAt: row.expires_at.toISOString(),
        association: row.a_id
          ? { id: row.a_id, status: row.a_status as never, createdAt: row.a_created!.toISOString(), confirmedAt: row.a_confirmed?.toISOString() ?? null }
          : null,
      };
    });
  }

  async cancel(ctx: Ctx, organizationId: string): Promise<void> {
    await this.db.asUser(ctx, async (tx) => {
      const member = await this.requireMembership(tx, organizationId);
      const r = await tx.query<{ id: string; location_id: string }>(
        `update togiva.customer_connection_codes set status = 'revoked', revoked_at = now(), revoked_reason = 'customer_cancelled'
          where organization_customer_id = $1 and status = 'active' returning id, location_id`,
        [member.id],
      );
      for (const c of r.rows) {
        await this.event(tx, { organizationId, locationId: c.location_id, codeId: c.id, customerId: member.id, type: "code_revoked", reason: "customer_cancelled", requestId: ctx.requestId, actor: ctx.userId });
      }
    });
  }

  // ------------------------------------------------------------------- cashier

  /**
   * Looks up and atomically reserves a code. Caller's customer.identify
   * permission at the location has already been checked by the route layer;
   * RLS enforces it again on every statement.
   */
  async lookup(ctx: Ctx, organizationId: string, locationId: string, input: LookupConnectionCodeRequest): Promise<ConnectionCodeReservation> {
    // Failures must be recorded even though the request fails, so the
    // transaction returns an outcome and the error is thrown after commit.
    const outcome = await this.db.asUser(ctx, async (tx): Promise<{ ok: ConnectionCodeReservation } | { err: AppError }> => {
      // Idempotent retry by the same cashier (e.g. network blip): return the same reservation.
      const prior = await tx.query<{ id: string; status: string }>(
        `select id, status from togiva.customer_connection_codes
          where location_id = $1 and reserved_by_user_id = $2 and reservation_idempotency_key = $3`,
        [locationId, ctx.userId, input.idempotencyKey],
      );
      if (prior.rows[0]?.status === "reserved") return { ok: await this.reservationView(tx, prior.rows[0].id) };

      const lockout = await tx.query<{ s: number }>("select togiva.connection_code_lockout_seconds($1) as s", [locationId]);
      const lockedFor = lockout.rows[0]?.s ?? 0;
      if (lockedFor > 0) {
        await this.event(tx, { organizationId, locationId, type: "lookup_locked_out", terminalId: input.terminalId, requestId: ctx.requestId, actor: ctx.userId });
        return { err: new AppError("connection_code_locked_out", "Too many incorrect codes. Lookups are paused briefly.", { retryAfterSeconds: lockedFor }) };
      }

      await tx.query("select togiva.expire_stale_connection_codes($1)", [locationId]);
      const settings = await this.settings(tx, organizationId);
      const hashes = this.hasher.candidates(organizationId, locationId, input.code);

      const reserved = await tx.query<{ id: string }>(
        `update togiva.customer_connection_codes
            set status = 'reserved', reserved_at = now(),
                reservation_expires_at = now() + make_interval(secs => $5),
                reserved_by_user_id = $4, reserved_terminal_id = $6, reservation_idempotency_key = $7
          where organization_id = $1 and location_id = $2 and code_hash = any($3::bytea[])
            and status = 'active' and expires_at > now()
          returning id`,
        [organizationId, locationId, hashes, ctx.userId, settings.reservation_ttl_seconds, input.terminalId ?? null, input.idempotencyKey],
      );
      const codeId = reserved.rows[0]?.id;
      if (codeId) {
        const view = await this.reservationView(tx, codeId);
        await this.event(tx, { organizationId, locationId, codeId, type: "lookup_succeeded", terminalId: input.terminalId, requestId: ctx.requestId, actor: ctx.userId });
        return { ok: view };
      }

      // Explain the failure without revealing anything about the customer.
      const seen = await tx.query<{ id: string; status: string }>(
        `select id, status from togiva.customer_connection_codes
          where organization_id = $1 and location_id = $2 and code_hash = any($3::bytea[])
          order by created_at desc limit 1`,
        [organizationId, locationId, hashes],
      );
      const s = seen.rows[0];
      let err: AppError;
      let reason: string;
      if (!s || s.status === "revoked") {
        reason = s ? "revoked" : "no_match";
        err = new AppError("connection_code_invalid", "That code isn't valid at this location. Ask the customer to check the location shown with their code, or refresh it.");
      } else if (s.status === "expired") {
        reason = "expired";
        err = new AppError("connection_code_expired", "That code has expired. Ask the customer to refresh it.");
      } else {
        reason = s.status === "reserved" ? "already_reserved" : "already_consumed";
        err = new AppError("connection_code_already_used", "That code is already being used for another checkout.");
      }
      await this.event(tx, { organizationId, locationId, codeId: s?.id, type: "lookup_failed", reason, terminalId: input.terminalId, requestId: ctx.requestId, actor: ctx.userId });
      return { err };
    });
    if ("err" in outcome) throw outcome.err;
    return outcome.ok;
  }

  async release(ctx: Ctx, organizationId: string, locationId: string, reservationId: string): Promise<void> {
    await this.db.asUser(ctx, async (tx) => {
      const code = await this.requireReservation(tx, organizationId, locationId, reservationId, ctx.userId);
      await tx.query(
        `update togiva.customer_connection_codes
            set status = 'active', reserved_at = null, reservation_expires_at = null, reserved_by_user_id = null,
                reserved_terminal_id = null, reservation_idempotency_key = null
          where id = $1`,
        [code.id],
      );
      await this.event(tx, { organizationId, locationId, codeId: code.id, customerId: code.organization_customer_id, type: "reservation_released", requestId: ctx.requestId, actor: ctx.userId });
    });
  }

  /**
   * Attaches the reserved customer to a POS order and consumes the code.
   * The association starts in pending_pos_confirmation; only the POS pipeline
   * can confirm it, and only a confirmed association can earn points.
   */
  async associate(ctx: Ctx, organizationId: string, locationId: string, reservationId: string, input: AssociateOrderRequest): Promise<TransactionAssociation> {
    return this.db.asUser(ctx, async (tx) => {
      const existing = await tx.query<AssociationRow>(`${associationSelect} where a.organization_id = $1 and a.idempotency_key = $2`, [organizationId, input.idempotencyKey]);
      if (existing.rows[0]) {
        if (existing.rows[0].connection_code_id !== reservationId) throw new AppError("idempotency_conflict", "This idempotency key was used for a different checkout");
        return toAssociation(existing.rows[0]);
      }

      const code = await this.requireReservation(tx, organizationId, locationId, reservationId, ctx.userId);

      if (input.posTransactionId) {
        // Must be a transaction from this location. Checked as the service would see it,
        // without granting cashiers general transaction read access.
        const t = await tx.query<{ ok: boolean }>(
          `select exists (select 1 from togiva.pos_transactions where id = $1 and organization_id = $2 and location_id = $3) as ok`,
          [input.posTransactionId, organizationId, locationId],
        );
        if (!t.rows[0]?.ok && !(await this.serviceTransactionAtLocation(input.posTransactionId, organizationId, locationId))) {
          throw new AppError("not_found", "That transaction was not found at this location");
        }
      }

      let row: AssociationRow;
      try {
        await tx.query("savepoint cc_assoc");
        const ins = await tx.query<{ id: string }>(
          `insert into togiva.customer_transaction_associations
             (organization_id, location_id, organization_customer_id, connection_code_id, provider_code, method,
              external_order_id, external_transaction_id, pos_transaction_id, associated_by_user_id, terminal_id, idempotency_key)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
          [organizationId, locationId, code.organization_customer_id, code.id, input.provider, input.method,
            input.externalOrderId ?? null, input.externalTransactionId ?? null, input.posTransactionId ?? null, ctx.userId, input.terminalId ?? null, input.idempotencyKey],
        );
        row = (await tx.query<AssociationRow>(`${associationSelect} where a.id = $1`, [ins.rows[0]!.id])).rows[0]!;
      } catch (err) {
        if (isPgError(err, PgErrorCode.uniqueViolation)) {
          throw new AppError("order_already_associated", "This order is already connected to a member");
        }
        if (isPgError(err, PgErrorCode.foreignKeyViolation)) throw new AppError("validation_failed", "Unknown POS provider or transaction");
        throw err;
      }

      await tx.query(
        "update togiva.customer_connection_codes set status = 'consumed', consumed_at = now(), association_id = $2, pos_transaction_id = $3 where id = $1",
        [code.id, row.id, input.posTransactionId ?? null],
      );
      await this.event(tx, { organizationId, locationId, codeId: code.id, customerId: code.organization_customer_id, associationId: row.id, type: "association_created", terminalId: input.terminalId, requestId: ctx.requestId, actor: ctx.userId });
      await this.event(tx, { organizationId, locationId, codeId: code.id, customerId: code.organization_customer_id, associationId: row.id, type: "code_consumed", requestId: ctx.requestId, actor: ctx.userId });
      await tx.query("select togiva.write_audit($1, 'connection.association.created', 'customer_transaction_association', $2, $3::jsonb, $4)", [
        organizationId, row.id, JSON.stringify({ method: input.method, provider: input.provider, terminalId: input.terminalId ?? null }), locationId,
      ]);
      // Durable follow-up: match the association to the POS-confirmed sale.
      await tx.query("select togiva.enqueue_job('connection_association.reconcile', $1::jsonb, $2, $3)", [
        JSON.stringify({ associationId: row.id }), organizationId, `assoc:${row.id}`,
      ]);
      return toAssociation(row);
    });
  }

  // ------------------------------------------------------------------- helpers

  private serviceTransactionAtLocation(id: string, organizationId: string, locationId: string): Promise<boolean> {
    return this.db.asService({ userId: null }, async (tx) => {
      const r = await tx.query("select 1 from togiva.pos_transactions where id = $1 and organization_id = $2 and location_id = $3", [id, organizationId, locationId]);
      return (r.rowCount ?? 0) > 0;
    });
  }

  private async requireMembership(tx: Queryable, organizationId: string): Promise<{ id: string }> {
    const r = await tx.query<{ id: string }>(
      `select id from togiva.organization_customers
        where organization_id = $1 and status = 'active' and id in (select togiva.my_organization_customer_ids())`,
      [organizationId],
    );
    if (!r.rows[0]) throw new AppError("membership_required", "Join the membership program first");
    return r.rows[0];
  }

  private async requireReservation(tx: Queryable, organizationId: string, locationId: string, reservationId: string, userId: string) {
    const r = await tx.query<{ id: string; status: string; reserved_by_user_id: string | null; reservation_expires_at: Date | null; organization_customer_id: string }>(
      `select id, status, reserved_by_user_id, reservation_expires_at, organization_customer_id
         from togiva.customer_connection_codes where id = $1 and organization_id = $2 and location_id = $3
         for update`,
      [reservationId, organizationId, locationId],
    );
    const code = r.rows[0];
    if (!code) throw new AppError("not_found", "Reservation not found");
    if (code.status !== "reserved") {
      throw code.status === "expired"
        ? new AppError("connection_code_reservation_expired", "This checkout timed out. Ask the customer for a new code.")
        : new AppError("connection_code_not_reserved_by_you", "This code is no longer reserved for your checkout");
    }
    if (code.reserved_by_user_id !== userId) throw new AppError("connection_code_not_reserved_by_you", "Another team member is using this code");
    if (code.reservation_expires_at && code.reservation_expires_at <= new Date()) {
      throw new AppError("connection_code_reservation_expired", "This checkout timed out. Look the code up again.");
    }
    return code;
  }

  private async reservationView(tx: Queryable, codeId: string): Promise<ConnectionCodeReservation> {
    const c = await tx.query<{ id: string; location_id: string; reserved_at: Date; reservation_expires_at: Date }>(
      "select id, location_id, reserved_at, reservation_expires_at from togiva.customer_connection_codes where id = $1",
      [codeId],
    );
    const s = await tx.query<{ first_name: string | null; membership_status: "active" | "suspended" | "closed"; membership_number_last4: string; tier_name: string | null }>(
      "select * from togiva.connection_code_customer_summary($1)",
      [codeId],
    );
    const code = c.rows[0]!;
    const summary = s.rows[0];
    if (!summary) throw new AppError("forbidden", "Not permitted to view this reservation");
    return {
      reservationId: code.id,
      locationId: code.location_id,
      reservedAt: code.reserved_at.toISOString(),
      reservationExpiresAt: code.reservation_expires_at.toISOString(),
      customer: {
        firstName: summary.first_name,
        membershipStatus: summary.membership_status,
        membershipNumberLast4: summary.membership_number_last4,
        tierName: summary.tier_name,
      },
    };
  }

  private async settings(tx: Queryable, organizationId: string) {
    const r = await tx.query<{ code_ttl_seconds: number; reservation_ttl_seconds: number; issue_limit_per_window: number; failure_window_seconds: number }>(
      "select * from togiva.connection_code_settings($1)",
      [organizationId],
    );
    return r.rows[0]!;
  }

  private async event(tx: Queryable, e: {
    organizationId: string; locationId?: string; codeId?: string; customerId?: string; associationId?: string;
    type: string; reason?: string; terminalId?: string; requestId: string; actor: string;
  }): Promise<void> {
    await tx.query(
      `insert into togiva.customer_connection_events
         (organization_id, location_id, connection_code_id, organization_customer_id, association_id, actor_user_id, event_type, reason, terminal_id, request_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [e.organizationId, e.locationId ?? null, e.codeId ?? null, e.customerId ?? null, e.associationId ?? null, e.actor, e.type, e.reason ?? null, e.terminalId ?? null, e.requestId],
    );
  }
}

type AssociationRow = {
  id: string; status: TransactionAssociation["status"]; method: TransactionAssociation["method"]; location_id: string;
  provider_code: string; external_order_id: string | null; external_transaction_id: string | null; pos_transaction_id: string | null;
  created_at: Date; connection_code_id: string | null;
};
const associationSelect = `select a.id, a.status, a.method, a.location_id, a.provider_code, a.external_order_id, a.external_transaction_id,
  a.pos_transaction_id, a.created_at, a.connection_code_id from togiva.customer_transaction_associations a`;

function toAssociation(r: AssociationRow): TransactionAssociation {
  return {
    id: r.id, status: r.status, method: r.method, locationId: r.location_id, provider: r.provider_code,
    externalOrderId: r.external_order_id, externalTransactionId: r.external_transaction_id, posTransactionId: r.pos_transaction_id,
    createdAt: r.created_at.toISOString(),
  };
}
