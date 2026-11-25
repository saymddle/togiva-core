import { z } from "zod";
import { ApiError } from "@togiva/shared-types";
import type { RouteContract } from "./route.js";

const statusFor: Record<string, string> = {
  unauthenticated: "401", forbidden: "403", not_found: "404", validation_failed: "400", conflict: "409", idempotency_conflict: "409",
  rate_limited: "429", connection_code_locked_out: "429", membership_required: "403", location_not_participating: "422",
  connection_code_invalid: "404", connection_code_expired: "410", connection_code_already_used: "409",
  connection_code_reservation_expired: "410", connection_code_not_reserved_by_you: "409", connection_code_space_exhausted: "503",
  order_already_associated: "409",
};

const schema = (s: z.ZodType) => z.toJSONSchema(s, { target: "openapi-3.0", io: "input", unrepresentable: "any" });

/** Builds an OpenAPI 3.0.3 document from the route contracts. */
export function buildOpenApi(routes: readonly RouteContract[], info: { version: string }) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    const parameters: unknown[] = [];
    for (const [where, obj] of [["path", r.params], ["query", r.query]] as const) {
      if (!obj) continue;
      for (const [name, s] of Object.entries(obj.shape)) {
        parameters.push({ name, in: where, required: where === "path" || !(s as z.ZodType).safeParse(undefined).success, schema: schema(s as z.ZodType) });
      }
    }
    const responses: Record<string, unknown> = {
      [String(r.successStatus)]: r.response
        ? { description: "Success", content: { "application/json": { schema: schema(r.response) } } }
        : { description: "Success" },
    };
    const byStatus = new Map<string, string[]>();
    for (const code of r.errors) {
      const st = statusFor[code] ?? "400";
      byStatus.set(st, [...(byStatus.get(st) ?? []), code]);
    }
    for (const [st, codes] of byStatus) {
      responses[st] = { description: codes.join(", "), content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } } };
    }
    (paths[r.path] ??= {})[r.method.toLowerCase()] = {
      operationId: r.id,
      summary: r.summary,
      description: r.description,
      tags: [r.owner],
      security: r.auth === "public" ? [] : [{ bearerAuth: [] }],
      "x-togiva-auth": r.auth,
      "x-togiva-permission": r.permission,
      "x-togiva-status": r.status,
      parameters,
      requestBody: r.body ? { required: true, content: { "application/json": { schema: schema(r.body) } } } : undefined,
      responses,
    };
  }
  return {
    openapi: "3.0.3",
    info: { title: "TOGIVA Core API", version: info.version, description: "Multi-tenant customer engagement platform API. Routes marked x-togiva-status: planned have fixed contracts but are not served yet." },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
      schemas: { ApiError: schema(ApiError) },
    },
    paths,
  };
}
