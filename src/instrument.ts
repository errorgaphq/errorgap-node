import { createRequire } from "node:module";
import diagnosticsChannel from "node:diagnostics_channel";
import { join } from "node:path";
import type { SpanCollector } from "./apm.js";
import { currentTransactionId } from "./transaction-context.js";

/**
 * Automatic spans: SQL queries made through `pg`, `mysql2` and `mysql`, and
 * outbound HTTP calls (`fetch` and `http`/`https`), recorded on whichever
 * transaction is running when they are made. Nothing is recorded outside a
 * transaction, and nothing here can make a query or request fail.
 *
 * Each package entry point is bundled separately, so the state lives on a
 * global symbol: every copy must see the same one.
 */
interface InstrumentState {
  collectors: Map<string, SpanCollector>;
  patched: WeakSet<object>;
  http: boolean;
  ignoredOrigin: string | undefined;
}

const STATE_KEY = Symbol.for("@errorgap/node/instrument-state");
const MAX_OPEN_TRANSACTIONS = 10_000;

function state(): InstrumentState {
  const root = globalThis as typeof globalThis & Record<symbol, unknown>;
  let existing = root[STATE_KEY] as InstrumentState | undefined;
  if (!existing) {
    existing = { collectors: new Map(), patched: new WeakSet(), http: false, ignoredOrigin: undefined };
    root[STATE_KEY] = existing;
  }
  return existing;
}

/**
 * Make `spans` the collector automatic spans go to while transaction `id`
 * runs. Returns a function to call when the transaction ends.
 */
export function collectSpans(id: string, spans: SpanCollector): () => void {
  const { collectors } = state();
  // A transaction whose end was never observed must not pin memory forever.
  if (collectors.size >= MAX_OPEN_TRANSACTIONS) {
    const oldest = collectors.keys().next().value;
    if (oldest !== undefined) collectors.delete(oldest);
  }
  collectors.set(id, spans);
  return () => {
    collectors.delete(id);
  };
}

/** The collector of the transaction this code is running in, if any. */
export function currentSpans(): SpanCollector | undefined {
  const id = currentTransactionId();
  return id === undefined ? undefined : state().collectors.get(id);
}

type AnyFunction = (this: unknown, ...args: unknown[]) => unknown;

interface Emitter {
  once(event: string, listener: () => void): unknown;
}

/**
 * Wrap a `query`-style method: time from the call until its callback runs,
 * its promise settles or its emitter ends, then record a `db` span.
 */
function wrapQuery(original: AnyFunction, sqlOf: (first: unknown) => string | undefined): AnyFunction {
  return function instrumentedQuery(this: unknown, ...args: unknown[]): unknown {
    // A driver method that calls another instrumented one (execute → query)
    // is one query, not two.
    const spans = nesting === 0 ? currentSpans() : undefined;
    const sql = spans ? safely(() => sqlOf(args[0])) : undefined;
    if (!spans || !sql) return original.apply(this, args);

    const start = performance.now();
    let recorded = false;
    const record = () => {
      if (recorded) return;
      recorded = true;
      safely(() => spans.database(sql, performance.now() - start));
    };

    const last = args.length - 1;
    if (typeof args[last] === "function") {
      const callback = args[last] as AnyFunction;
      args[last] = function (this: unknown, ...results: unknown[]) {
        record();
        return callback.apply(this, results);
      };
      return nested(() => original.apply(this, args));
    }

    const result = nested(() => original.apply(this, args));
    safely(() => {
      const thenable = result as { then?: (ok: () => void, fail: () => void) => unknown } | undefined;
      if (thenable && typeof thenable.then === "function") {
        // Observed, not replaced: the caller still gets the driver's promise.
        void thenable.then(record, record);
      } else if (result && typeof (result as Emitter).once === "function") {
        (result as Emitter).once("end", record);
        (result as Emitter).once("error", record);
      } else {
        record();
      }
    });
    return result;
  };
}

let nesting = 0;

function nested<T>(call: () => T): T {
  nesting++;
  try {
    return call();
  } finally {
    nesting--;
  }
}

function safely<T>(operation: () => T): T | undefined {
  try {
    return operation();
  } catch {
    return undefined;
  }
}

function patch(prototype: unknown, method: string, sqlOf: (first: unknown) => string | undefined): boolean {
  if (!prototype || typeof prototype !== "object") return false;
  const target = prototype as Record<string, unknown>;
  const original = target[method];
  if (typeof original !== "function") return false;
  const { patched } = state();
  if (patched.has(original)) return true;
  const wrapped = wrapQuery(original as AnyFunction, sqlOf);
  patched.add(wrapped);
  target[method] = wrapped;
  return true;
}

const textOf = (first: unknown): string | undefined =>
  typeof first === "string" ? first : (first as { text?: unknown } | undefined)?.text?.toString();
const sqlOf = (first: unknown): string | undefined =>
  typeof first === "string" ? first : (first as { sql?: unknown } | undefined)?.sql?.toString();

/** Record queries made through `pg` (`import pg from "pg"`; pools use `Client` underneath). */
export function instrumentPg(pg: unknown): boolean {
  const client = (pg as { Client?: { prototype?: unknown } } | undefined)?.Client;
  return patch(client?.prototype, "query", textOf);
}

/** Record queries made through `mysql2` (`import mysql from "mysql2"`, also covers `mysql2/promise`). */
export function instrumentMysql2(mysql2: unknown): boolean {
  const connection = (mysql2 as { Connection?: { prototype?: unknown } } | undefined)?.Connection;
  const query = patch(connection?.prototype, "query", sqlOf);
  const execute = patch(connection?.prototype, "execute", sqlOf);
  return query || execute;
}

/** Record queries made through `mysql` (pass `require("mysql/lib/Connection")`). */
export function instrumentMysql(connection: unknown): boolean {
  return patch((connection as { prototype?: unknown } | undefined)?.prototype, "query", sqlOf);
}

/**
 * Record outbound HTTP calls as `http` spans named by method and host, using
 * Node's diagnostics channels (no patching). Calls to `ignoredEndpoint` (the
 * errorgap server) are left out.
 */
export function instrumentHttp(ignoredEndpoint?: string): boolean {
  const current = state();
  current.ignoredOrigin = safely(() => (ignoredEndpoint ? new URL(ignoredEndpoint).origin : undefined));
  if (current.http) return true;
  current.http = true;

  const pending = new WeakMap<object, { start: number; spans: SpanCollector; label: string }>();
  const begin = (request: object | undefined, method: unknown, origin: string | undefined) => {
    const spans = currentSpans();
    if (!spans || !request || !origin || origin === state().ignoredOrigin) return;
    const host = safely(() => new URL(origin).host) ?? origin;
    pending.set(request, { start: performance.now(), spans, label: `${String(method ?? "GET").toUpperCase()} ${host}` });
  };
  const finish = (request: object | undefined) => {
    const entry = request ? pending.get(request) : undefined;
    if (!entry || !request) return;
    pending.delete(request);
    entry.spans.external(performance.now() - entry.start, { function: entry.label });
  };
  const subscribe = (name: string, listener: (message: unknown) => void) =>
    safely(() => diagnosticsChannel.subscribe(name, (message) => void safely(() => listener(message))));

  // fetch (undici)
  subscribe("undici:request:create", (message) => {
    const request = (message as { request?: { method?: unknown; origin?: unknown } }).request;
    begin(request, request?.method, typeof request?.origin === "string" ? request.origin : undefined);
  });
  subscribe("undici:request:trailers", (message) => finish((message as { request?: object }).request));
  subscribe("undici:request:error", (message) => finish((message as { request?: object }).request));

  // http / https
  subscribe("http.client.request.start", (message) => {
    const request = (message as { request?: { method?: unknown; protocol?: unknown; host?: unknown; getHeader?: (name: string) => unknown } })
      .request;
    const host = request?.getHeader?.("host") ?? request?.host;
    const origin = typeof host === "string" ? `${String(request?.protocol ?? "http:")}//${host}` : undefined;
    begin(request, request?.method, origin);
  });
  subscribe("http.client.response.finish", (message) => finish((message as { request?: object }).request));
  subscribe("http.client.request.error", (message) => finish((message as { request?: object }).request));
  return true;
}

/**
 * Instrument whatever the app has installed: `pg`, `mysql2` and `mysql`
 * resolved from `rootDirectory`, plus outbound HTTP. Returns what was found.
 */
export function instrumentInstalled(rootDirectory: string, ignoredEndpoint?: string): string[] {
  const found: string[] = [];
  const load = safely(() => createRequire(join(rootDirectory, "noop.js")));
  const attempt = (name: string, apply: (loaded: unknown) => boolean) => {
    if (!load) return;
    const loaded = safely(() => load(name) as unknown);
    if (loaded && safely(() => apply(loaded))) found.push(name);
  };
  attempt("pg", instrumentPg);
  attempt("mysql2", instrumentMysql2);
  attempt("mysql/lib/Connection", instrumentMysql);
  if (instrumentHttp(ignoredEndpoint)) found.push("http");
  return found;
}
