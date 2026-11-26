import type { FastifyRequest } from "fastify";
import type { Identity } from "../auth/verifier.js";

declare module "fastify" {
  interface FastifyRequest {
    identity: Identity | null;
  }
}

export function ctxOf(req: FastifyRequest) {
  return { userId: req.identity?.userId ?? null, requestId: req.id };
}
