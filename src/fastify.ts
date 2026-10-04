import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { SpanCollector, TRACE_HEADER, browserTraceId } from "./apm.js";
import { Errorgap } from "./index.js";
import { newTransactionId, runInTransaction } from "./transaction-context.js";

const STATE_KEY = Symbol.for("@errorgap/node/fastify-transaction");

interface RequestTransaction {
  id: string;
  spans: SpanCollector;
  startedAt: string;
  start: number;
}

export interface ErrorgapFastifyOptions {
  /**
   * When true, re-throws the error after notifying so other error handlers run.
   * Defaults to false (Fastify sends its default error response).
   */
  rethrow?: boolean;
}

export const errorgapPlugin = fp<ErrorgapFastifyOptions>(
  async (fastify: FastifyInstance, options) => {
    // Each request is an APM transaction (sent with apmEnabled). Running the
    // rest of the lifecycle inside the transaction scope makes errors
    // reported from handlers, and by the error handler below, carry its id.
    fastify.addHook("onRequest", (request, _reply, done) => {
      const id = newTransactionId();
      const state: RequestTransaction = {
        id,
        spans: new SpanCollector(),
        startedAt: new Date().toISOString(),
        start: performance.now(),
      };
      (request as unknown as Record<symbol, unknown>)[STATE_KEY] = state;
      runInTransaction(id, () => done());
    });

    fastify.addHook("onResponse", async (request, reply) => {
      const state = (request as unknown as Record<symbol, unknown>)[STATE_KEY] as
        | RequestTransaction
        | undefined;
      if (!state) return;
      void Errorgap.notifyTransaction({
        id: state.id,
        traceId: browserTraceId(request.headers[TRACE_HEADER]),
        kind: "web",
        method: request.method,
        path: request.routeOptions?.url ?? request.url.split("?")[0],
        pathRaw: request.url.split("?")[0],
        statusCode: reply.statusCode,
        durationMs: performance.now() - state.start,
        occurredAt: state.startedAt,
        spans: state.spans.snapshot(),
      });
    });

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

/**
 * The span collector for this request's transaction, for recording DB and
 * outbound HTTP spans from route handlers.
 */
export function requestSpans(request: FastifyRequest): SpanCollector | undefined {
  const state = (request as unknown as Record<symbol, unknown>)[STATE_KEY] as
    | RequestTransaction
    | undefined;
  return state?.spans;
}

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
