import type { ErrorRequestHandler, Request } from "express";
import { Errorgap } from "./index.js";

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
