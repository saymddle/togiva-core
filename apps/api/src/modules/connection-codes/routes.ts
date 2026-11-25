import type { FastifyInstance } from "fastify";
import { v1 } from "@togiva/api-contracts";
import type { Database } from "@togiva/database";
import { registerRoute } from "../../http/register.js";
import type { ConnectionCodeService } from "./service.js";

const uid = (c: { userId: string | null; requestId: string }) => ({ userId: c.userId!, requestId: c.requestId });

export function connectionCodeRoutes(app: FastifyInstance, db: Database, svc: ConnectionCodeService): void {
  registerRoute(app, db, v1.issueConnectionCode, ({ ctx, params, body }) => svc.issue(uid(ctx), params.organizationId, body.locationId));
  registerRoute(app, db, v1.getCurrentConnectionCode, ({ ctx, params }) => svc.current(uid(ctx), params.organizationId));
  registerRoute(app, db, v1.cancelConnectionCode, ({ ctx, params }) => svc.cancel(uid(ctx), params.organizationId));
  registerRoute(app, db, v1.lookupConnectionCode, ({ ctx, params, body }) => svc.lookup(uid(ctx), params.organizationId, params.locationId, body));
  registerRoute(app, db, v1.releaseConnectionReservation, ({ ctx, params }) =>
    svc.release(uid(ctx), params.organizationId, params.locationId, params.reservationId));
  registerRoute(app, db, v1.associateOrder, ({ ctx, params, body }) =>
    svc.associate(uid(ctx), params.organizationId, params.locationId, params.reservationId, body));
}
