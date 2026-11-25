import Fastify, { type FastifyInstance } from "fastify";
import { v1 } from "@togiva/api-contracts";
import type { Database } from "@togiva/database";
import type { IdentityVerifier } from "./auth/verifier.js";
import { AppError } from "./errors.js";
import { registerRoute } from "./http/register.js";
import "./http/request-context.js";
import { ConnectionCodeHasher } from "./modules/connection-codes/crypto.js";
import { connectionCodeRoutes } from "./modules/connection-codes/routes.js";
import { ConnectionCodeService } from "./modules/connection-codes/service.js";
import { enroll } from "./modules/identity/enrollment.js";
import { ensureUserProfile, getMe } from "./modules/identity/service.js";
import { getLocation, listLocations } from "./modules/organizations/service.js";

export interface AppDeps {
  db: Database;
  verifier: IdentityVerifier;
  hasher: ConnectionCodeHasher;
  version?: string;
  logger?: boolean | object;
  trustProxy?: boolean;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: deps.logger ?? false,
    trustProxy: deps.trustProxy ?? false,
    genReqId: () => crypto.randomUUID(),
    // Never log tokens or connection codes.
    // (Fastify's default serializers do not log bodies or headers.)
  });
  const { db } = deps;

  app.decorateRequest("identity", null);
  app.addHook("onRequest", async (req) => {
    const header = req.headers.authorization;
    if (!header) return;
    const [scheme, token] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token) throw new AppError("unauthenticated", "Malformed Authorization header");
    try {
      req.identity = await deps.verifier.verify(token);
    } catch {
      throw new AppError("unauthenticated", "Invalid or expired token");
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      if (err.extra.retryAfterSeconds) reply.header("retry-after", String(err.extra.retryAfterSeconds));
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, requestId: req.id, details: err.extra.details, retryAfterSeconds: err.extra.retryAfterSeconds } });
    }
    const fastifyErr = err as { statusCode?: number; validation?: unknown };
    if (fastifyErr.statusCode && fastifyErr.statusCode < 500) {
      return reply.status(fastifyErr.statusCode).send({ error: { code: "validation_failed", message: "Malformed request", requestId: req.id } });
    }
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({ error: { code: "internal_error", message: "Something went wrong", requestId: req.id } });
  });

  registerRoute(app, db, v1.health, async () => {
    const ok = await db.pool.query("select 1").then(() => true, () => false);
    return { status: "ok" as const, version: deps.version ?? "dev", database: ok ? ("ok" as const) : ("unavailable" as const) };
  });

  registerRoute(app, db, v1.getMe, async ({ req, ctx }) => {
    await ensureUserProfile(db, req.identity!, ctx.requestId);
    return getMe(db, { userId: ctx.userId!, requestId: ctx.requestId });
  });

  registerRoute(app, db, v1.enroll, async ({ req, ctx, params, body, setStatus }) => {
    await ensureUserProfile(db, req.identity!, ctx.requestId);
    const { created, membership } = await enroll(db, { userId: ctx.userId!, requestId: ctx.requestId }, params.organizationId, body);
    if (!created) setStatus(200);
    return membership;
  });

  registerRoute(app, db, v1.listLocations, ({ ctx, params, query }) => listLocations(db, ctx, params.organizationId, query));
  registerRoute(app, db, v1.getLocation, ({ ctx, params }) => getLocation(db, ctx, params.organizationId, params.locationId));

  connectionCodeRoutes(app, db, new ConnectionCodeService(db, deps.hasher));
  return app;
}
