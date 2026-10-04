import type { ErrorRequestHandler, Request, RequestHandler, Response } from "express";
import { SpanCollector, TRACE_HEADER, browserTraceId } from "./apm.js";
import { Errorgap } from "./index.js";
import { newTransactionId, runInTransaction } from "./transaction-context.js";

const SPANS_KEY = Symbol.for("@errorgap/node/express-spans");

/**
 * Time each request as an APM transaction. Mount it first, before your
 * routes. Errors reported while the request runs — including by
 * `errorgapErrorHandler` — carry its transaction id, and the browser SDK's
 * `x-errorgap-trace` header links the browser's view of the call to it.
 * Transactions are sent only with `apmEnabled`.
 */
export function errorgapRequestHandler(): RequestHandler {
  return (req, res, next) => {
    const id = newTransactionId();
    const spans = new SpanCollector();
    (res.locals as Record<symbol, unknown>)[SPANS_KEY] = spans;
    const startedAt = new Date().toISOString();
    const start = performance.now();
    const matched = captureRoute(req);
    let recorded = false;
    const record = () => {
      if (recorded) return;
      recorded = true;
      void Errorgap.notifyTransaction({
        id,
        traceId: browserTraceId(req.get(TRACE_HEADER)),
        kind: "web",
        method: req.method,
        path: matched() ?? req.originalUrl.split("?")[0] ?? req.path,
        pathRaw: req.originalUrl.split("?")[0] ?? req.path,
        statusCode: res.statusCode,
        durationMs: performance.now() - start,
        occurredAt: startedAt,
        spans: spans.snapshot(),
      });
    };
    res.once("finish", record);
    res.once("close", record);
    runInTransaction(id, () => next());
  };
}

/**
 * The span collector for this request's transaction, for recording DB and
 * outbound HTTP spans from route handlers.
 */
export function requestSpans(res: Response): SpanCollector | undefined {
  return (res.locals as Record<symbol, unknown>)[SPANS_KEY] as SpanCollector | undefined;
}

/**
 * The matched route template (`/orders/:id`, including any router mount
 * path). Express restores `req.baseUrl` as `next(err)` unwinds the routers,
 * so the template is captured at the moment the router assigns `req.route`.
 */
function captureRoute(req: Request): () => string | undefined {
  let template: string | undefined;
  let route: unknown = req.route;
  Object.defineProperty(req, "route", {
    configurable: true,
    enumerable: true,
    get: () => route,
    set: (value: unknown) => {
      route = value;
      const path = (value as { path?: unknown } | undefined)?.path;
      if (typeof path === "string") template = `${req.baseUrl ?? ""}${path}` || "/";
    },
  });
  return () => template;
}

export function errorgapErrorHandler(): ErrorRequestHandler {
  return (err, req, _res, next) => {
    void Errorgap.notify(err, {
      sync: true,
      context: requestContext(req),
      environment: requestEnvironment(req),
      params: requestParams(req),
    });
    next(err);
  };
}

function requestContext(req: Request): Record<string, unknown> {
  return {
    url: fullUrl(req),
    component: req.route?.path ?? req.path,
    action: req.method,
  };
}

function requestEnvironment(req: Request): Record<string, unknown> {
  return {
    method: req.method,
    path: req.path,
    query_string: stringifyQuery(req.query),
    user_agent: req.get("user-agent"),
    remote_addr: req.ip,
  };
}

function requestParams(req: Request): Record<string, unknown> {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  return { ...req.query, ...body };
}

function fullUrl(req: Request): string {
  return `${req.protocol}://${req.get("host") ?? ""}${req.originalUrl ?? req.url}`;
}

function stringifyQuery(query: unknown): string {
  if (!query || typeof query !== "object") return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      for (const v of value) params.append(key, String(v));
    } else if (value != null) {
      params.append(key, String(value));
    }
  }
  return params.toString();
}
