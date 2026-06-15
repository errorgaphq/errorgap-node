import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { Errorgap } from "./index.js";

export interface ErrorgapFastifyOptions {
  /**
   * When true, re-throws the error after notifying so other error handlers run.
   * Defaults to false (Fastify sends its default error response).
   */
  rethrow?: boolean;
}

export const errorgapPlugin = fp<ErrorgapFastifyOptions>(
  async (fastify: FastifyInstance, options) => {
    fastify.setErrorHandler(async (err, request, reply) => {
      await Errorgap.notify(err, {
        sync: true,
        context: requestContext(request),
        environment: requestEnvironment(request),
        params: requestParams(request),
      });

      if (options.rethrow) throw err;
      return reply.send(err);
    });
  },
  { name: "errorgap", fastify: "4.x" },
);

function requestContext(req: FastifyRequest): Record<string, unknown> {
  return {
    url: `${req.protocol}://${req.hostname}${req.url}`,
    component: req.routeOptions?.url ?? req.url,
    action: req.method,
  };
}

function requestEnvironment(req: FastifyRequest): Record<string, unknown> {
  return {
    method: req.method,
    path: req.url,
    user_agent: req.headers["user-agent"],
    remote_addr: req.ip,
  };
}

function requestParams(req: FastifyRequest): Record<string, unknown> {
  const body =
    req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};
  const query =
    req.query && typeof req.query === "object" && !Array.isArray(req.query)
      ? (req.query as Record<string, unknown>)
      : {};
  return { ...query, ...body };
}
