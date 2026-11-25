import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RouteContract } from "@togiva/api-contracts";
import type { z } from "zod";
import type { Database } from "@togiva/database";
import { AppError } from "../errors.js";
import { ctxOf } from "./request-context.js";

type Infer<T> = T extends z.ZodType ? z.infer<T> : undefined;

export interface HandlerInput<R extends RouteContract> {
  params: Infer<R["params"]>;
  query: Infer<R["query"]>;
  body: Infer<R["body"]>;
  req: FastifyRequest;
  reply: FastifyReply;
  ctx: { userId: string | null; requestId: string };
  /** Override the contract's success status (e.g. 200 instead of 201 when nothing was created). */
  setStatus: (code: number) => void;
}

const toFastifyPath = (p: string) => p.replace(/\{(\w+)\}/g, ":$1");

/**
 * Registers a route from its contract: parses params/query/body with the
 * contract's schemas, enforces `auth`, and for staff routes checks the
 * contract's permission at the location (or organization) in the path using
 * the same SQL function row-level security uses. Handlers never re-implement
 * authorization rules.
 */
export function registerRoute<R extends RouteContract>(
  app: FastifyInstance,
  db: Database,
  route: R,
  handler: (input: HandlerInput<R>) => Promise<Infer<R["response"]> | void>,
): void {
  app.route({
    method: route.method,
    url: toFastifyPath(route.path),
    handler: async (req, reply) => {
      const parse = <S extends z.ZodType | undefined>(schema: S, value: unknown, what: string) => {
        if (!schema) return undefined;
        const r = schema.safeParse(value ?? {});
        if (!r.success) throw new AppError("validation_failed", `Invalid ${what}`, { details: r.error.issues });
        return r.data;
      };
      const params = parse(route.params, req.params, "path parameters") as Infer<R["params"]>;
      const query = parse(route.query, req.query, "query") as Infer<R["query"]>;
      const body = parse(route.body, req.body, "body") as Infer<R["body"]>;

      if (route.auth !== "public" && !req.identity) throw new AppError("unauthenticated", "Sign in required");
      if (route.auth === "staff") {
        const p = params as { organizationId?: string; locationId?: string };
        const allowed = await db.asUser(ctxOf(req), async (tx) => {
          if (p.locationId) {
            const r = await tx.query<{ ok: boolean }>(
              "select togiva.has_location_permission($1, $2) and exists (select 1 from togiva.locations where id = $1 and organization_id = $3) as ok",
              [p.locationId, route.permission, p.organizationId],
            );
            return r.rows[0]?.ok === true;
          }
          const r = await tx.query<{ ok: boolean }>("select togiva.has_org_permission($1, $2) as ok", [p.organizationId, route.permission]);
          return r.rows[0]?.ok === true;
        });
        if (!allowed) throw new AppError("forbidden", "You do not have access to this action at this location");
      }

      let status: number = route.successStatus;
      const result = await handler({ params, query, body, req, reply, ctx: ctxOf(req), setStatus: (c) => { status = c; } });
      // Contract conformance: outside production every response is validated
      // against the published contract so drift fails tests, not clients.
      if (route.response && process.env.NODE_ENV !== "production") route.response.parse(result);
      reply.status(status);
      if (status === 204) return reply.send();
      return reply.send(result);
    },
  });
}
