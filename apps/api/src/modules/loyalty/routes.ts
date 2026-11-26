import type { FastifyInstance } from "fastify";
import { v1 } from "@togiva/api-contracts";
import type { Database, Queryable } from "@togiva/database";
import { registerRoute } from "../../http/register.js";
import { decideAdjustment, listAdjustments, requestAdjustment } from "./adjustments.js";
import { getWallet, listActivity, listRewards } from "./customer.js";
import type { RedemptionService } from "./redemptions.js";

/*
 * Loyalty routes. Authorization (customer membership, staff permission at the
 * location or organization) is enforced by registerRoute from the contract;
 * the services then scope every query to the caller. Reads and writes run as
 * the service role because the ledger, balances and redemptions are written
 * only by the loyalty engine.
 */
export function loyaltyRoutes(app: FastifyInstance, db: Database, redemptions: RedemptionService): void {
  const svc = <T>(ctx: { userId: string | null; requestId: string }, fn: (tx: Queryable) => Promise<T>) => db.asService(ctx, fn);

  registerRoute(app, db, v1.getWallet, ({ ctx, params }) => svc(ctx, (tx) => getWallet(tx, ctx.userId!, params.organizationId)));
  registerRoute(app, db, v1.listActivity, ({ ctx, params, query }) => svc(ctx, (tx) => listActivity(tx, ctx.userId!, params.organizationId, query)));
  registerRoute(app, db, v1.listRewards, ({ ctx, params, query }) => svc(ctx, (tx) => listRewards(tx, ctx.userId!, params.organizationId, query)));

  registerRoute(app, db, v1.issueRedemption, async ({ ctx, params, body, setStatus }) => {
    const { created, redemption } = await svc(ctx, (tx) => redemptions.issue(tx, ctx.userId!, params.organizationId, body));
    if (!created) setStatus(200);
    return redemption;
  });
  registerRoute(app, db, v1.listMyRedemptions, ({ ctx, params, query }) => svc(ctx, (tx) => redemptions.listMine(tx, ctx.userId!, params.organizationId, query)));
  registerRoute(app, db, v1.getMyRedemption, ({ ctx, params }) => svc(ctx, (tx) => redemptions.showMine(tx, ctx.userId!, params.organizationId, params.redemptionId)));
  registerRoute(app, db, v1.cancelMyRedemption, ({ ctx, params }) => svc(ctx, (tx) => redemptions.cancelMine(tx, ctx.userId!, params.organizationId, params.redemptionId)));

  registerRoute(app, db, v1.verifyRedemption, ({ ctx, params, body }) => svc(ctx, (tx) => redemptions.verify(tx, params.organizationId, params.locationId, body.token)));
  registerRoute(app, db, v1.completeRedemption, ({ ctx, params, body }) =>
    svc(ctx, (tx) => redemptions.complete(tx, { userId: ctx.userId! }, params.organizationId, params.locationId, body)));

  registerRoute(app, db, v1.requestLocationAdjustment, ({ ctx, params, body }) =>
    svc(ctx, (tx) => requestAdjustment(tx, { userId: ctx.userId! }, params.organizationId, { ...body, locationId: params.locationId })));
  registerRoute(app, db, v1.requestAdjustment, ({ ctx, params, body }) => svc(ctx, (tx) => requestAdjustment(tx, { userId: ctx.userId! }, params.organizationId, body)));
  registerRoute(app, db, v1.listAdjustments, ({ ctx, params, query }) => svc(ctx, (tx) => listAdjustments(tx, params.organizationId, query)));
  registerRoute(app, db, v1.decideAdjustment, ({ ctx, params, body }) =>
    svc(ctx, (tx) => decideAdjustment(tx, { userId: ctx.userId! }, params.organizationId, params.adjustmentId, body.decision, body.note)));
}
