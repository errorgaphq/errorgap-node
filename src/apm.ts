import type { Configuration } from "./configuration.js";

export interface Span {
  kind: string;
  sql?: string;
  file?: string;
  line?: number;
  function?: string;
  durationMs: number;
}

export interface SpanLocation {
  file?: string;
  line?: number;
  function?: string;
}

export function databaseSpan(sql: string, durationMs: number, location: SpanLocation = {}): Span {
  return { kind: "db", sql: normalizeSql(sql), durationMs, ...location };
}

export function externalSpan(durationMs: number, location: SpanLocation = {}): Span {
  return { kind: "http", durationMs, ...location };
}

/** Collects spans recorded while a transaction or job is in flight. */
export class SpanCollector {
  private spans: Span[] = [];

  add(span: Span): void {
    this.spans.push(span);
  }

  database(sql: string, durationMs: number, location: SpanLocation = {}): void {
    this.add(databaseSpan(sql, durationMs, location));
  }

  external(durationMs: number, location: SpanLocation = {}): void {
    this.add(externalSpan(durationMs, location));
  }

  snapshot(): Span[] {
    return [...this.spans];
  }
}

export interface Transaction {
  /** Links the errors raised during this transaction to it. */
  id?: string;
  /**
   * The `x-errorgap-trace` header the errorgap browser SDK sent with the
   * request (see `browserTraceId`); links the browser's view of the call to
   * this transaction.
   */
  traceId?: string;
  /** "web" for HTTP interactions, "job" for background work. */
  kind?: string;
  method?: string;
  /** Normalized route template used for grouping, e.g. `/orders/:id`. */
  path?: string;
  /** Concrete path for a single request, e.g. `/orders/123`. */
  pathRaw?: string;
  statusCode?: number;
  durationMs: number;
  environment?: string;
  /** ISO-8601. Defaults to now. */
  occurredAt?: string;
  spans?: Span[];
  jobClass?: string;
  queue?: string;
}

/** The header the errorgap browser SDK sends with API calls. */
export const TRACE_HEADER = "x-errorgap-trace";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The trace id in an `x-errorgap-trace` header value, lowercased, or
 * `undefined` unless it is a well-formed UUID.
 */
export function browserTraceId(header: string | string[] | null | undefined): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().toLowerCase();
  return UUID.test(value) ? value : undefined;
}

export function transactionPayload(
  transaction: Transaction,
  configuration: Configuration,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    kind: transaction.kind ?? "web",
    duration_ms: transaction.durationMs,
    environment: transaction.environment ?? configuration.environment,
    occurred_at: transaction.occurredAt ?? new Date().toISOString(),
    spans: (transaction.spans ?? []).map(spanPayload),
  };
  if (transaction.id !== undefined) payload.id = transaction.id;
  if (transaction.traceId !== undefined) payload.trace_id = transaction.traceId;
  if (transaction.method !== undefined) payload.method = transaction.method;
  if (transaction.path !== undefined) payload.path = transaction.path;
  if (transaction.pathRaw !== undefined) payload.path_raw = transaction.pathRaw;
  if (transaction.statusCode !== undefined) payload.status_code = transaction.statusCode;
  if (transaction.jobClass !== undefined) payload.job_class = transaction.jobClass;
  if (transaction.queue !== undefined) payload.queue = transaction.queue;
  return payload;
}

function spanPayload(span: Span): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    kind: span.kind,
    duration_ms: span.durationMs,
  };
  if (span.sql !== undefined) payload.sql = span.sql;
  if (span.file !== undefined) payload.file = span.file;
  if (span.line !== undefined) payload.line = span.line;
  if (span.function !== undefined) payload.fn_name = span.function;
  return payload;
}

/** Strip literals so query shapes aggregate: '…' and numbers become ?. */
export function normalizeSql(sql: string): string {
  return sql
    .replace(/'(?:''|[^'])*'/g, "?")
    .replace(/\b\d+(?:\.\d+)?\b/g, "?")
    .replace(/\s+/g, " ")
    .trim();
}
