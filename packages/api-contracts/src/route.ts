import type { z } from "zod";
import type { Permission } from "@togiva/shared-types";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Who may call a route.
 *  public   - no token
 *  user     - any authenticated identity
 *  customer - authenticated, acting on their own membership in :organizationId
 *  staff    - authenticated staff; `permission` is checked at the location in
 *             the path (or organization-wide when the path has no location)
 */
export type RouteAuth = "public" | "user" | "customer" | "staff";

export interface RouteContract {
  id: string;
  method: HttpMethod;
  /** OpenAPI-style path, e.g. /v1/organizations/{organizationId}/locations */
  path: string;
  summary: string;
  description?: string;
  auth: RouteAuth;
  permission?: Permission;
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodType;
  /** 2xx response body; undefined for 204. */
  response?: z.ZodType;
  successStatus: 200 | 201 | 202 | 204;
  errors: readonly string[];
  /** "implemented" routes are served by apps/api today; "planned" contracts are fixed but not yet served. */
  status: "implemented" | "planned";
  /** Module that owns the implementation (see docs/MODULE_OWNERSHIP.md). */
  owner: string;
}

export const defineRoute = <T extends RouteContract>(r: T): T => r;
