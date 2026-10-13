import { Configuration, type ConfigurationInput } from "./configuration.js";
import { Client, type DeliveryResult } from "./client.js";
import { installProcessHandlers, uninstallProcessHandlers } from "./handlers.js";
import type { NoticeContext } from "./notice.js";
import { SpanCollector, type Transaction } from "./apm.js";
import { currentTransactionId, newTransactionId, runInTransaction } from "./transaction-context.js";
import { VERSION } from "./version.js";
import { collectSpans, instrumentInstalled } from "./instrument.js";
import type { SignInOptions, SignInOutcome } from "./sign-ins.js";

export type { BeforeNotify, ConfigurationInput, Logger } from "./configuration.js";
export type { NoticeContext, NoticePayload, NoticeUser } from "./notice.js";
export type { FilterKey } from "./filter.js";
export type { BacktraceFrame } from "./backtrace.js";
export type { DeliveryResult } from "./client.js";
export { Configuration } from "./configuration.js";
export { Client } from "./client.js";
export type { Span, SpanLocation, Transaction } from "./apm.js";
export { SpanCollector, TRACE_HEADER, browserTraceId, normalizeSql } from "./apm.js";
export { currentTransactionId, newTransactionId, runInTransaction } from "./transaction-context.js";
export type { SignInOptions, SignInOutcome, SignInRequest } from "./sign-ins.js";
export {
  collectSpans,
  currentSpans,
  instrumentHttp,
  instrumentMysql,
  instrumentMysql2,
  instrumentPg,
} from "./instrument.js";
export { VERSION };

interface RuntimeState {
  configuration: Configuration;
  client: Client;
}

const RUNTIME_STATE_KEY = Symbol.for("@errorgap/node/runtime-state");

function runtimeState(): RuntimeState {
  const runtimeGlobal = globalThis as typeof globalThis & Record<symbol, unknown>;
  const existing = runtimeGlobal[RUNTIME_STATE_KEY] as RuntimeState | undefined;
  if (existing) return existing;

  const configuration = new Configuration();
  const state = { configuration, client: new Client(configuration) };
  runtimeGlobal[RUNTIME_STATE_KEY] = state;
  return state;
}

export interface InitOptions extends ConfigurationInput {
  /**
   * Install process-level handlers for `uncaughtException` and
   * `unhandledRejection`. Defaults to `true`.
   */
  captureGlobals?: boolean;
  /**
   * After reporting an uncaught exception or unhandled rejection, exit with
   * code 1 as Node does without a listener, unless the app has its own
   * listener for the event. Defaults to `true`.
   */
  exitOnUncaught?: boolean;
}

function init(options: InitOptions = {}): void {
  const { captureGlobals = true, exitOnUncaught = true, ...rest } = options;
  const state = runtimeState();
  state.configuration = new Configuration(rest);
  state.client.configure(state.configuration);
  if (state.configuration.apmEnabled && state.configuration.autoInstrument) {
    instrumentInstalled(state.configuration.rootDirectory, state.configuration.endpoint);
  }
  if (captureGlobals) {
    installProcessHandlers(state.client, { exitOnUncaught });
  } else {
    uninstallProcessHandlers();
  }
}

function notify(
  error: unknown,
  options: NoticeContext & { sync?: boolean } = {},
): Promise<DeliveryResult> {
  return runtimeState().client.notify(error, options);
}

/** Deliver an APM transaction (HTTP interaction or background job). */
function notifyTransaction(
  transaction: Transaction,
  options: { sync?: boolean } = {},
): Promise<DeliveryResult> {
  return runtimeState().client.notifyTransaction(transaction, options);
}

/**
 * Time an HTTP interaction and deliver it as a transaction. The callback
 * receives a `SpanCollector` for recording DB/HTTP spans; errors reported
 * while it runs carry the transaction's id.
 */
async function trackTransaction<T>(
  meta: Omit<Transaction, "durationMs" | "spans" | "kind"> & { kind?: string },
  operation: (spans: SpanCollector) => Promise<T> | T,
): Promise<T> {
  const spans = new SpanCollector();
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const id = meta.id ?? newTransactionId();
  const done = collectSpans(id, spans);
  try {
    return await runInTransaction(id, () => operation(spans));
  } finally {
    done();
    void notifyTransaction({
      kind: meta.kind ?? "web",
      ...meta,
      id,
      occurredAt: meta.occurredAt ?? startedAt,
      durationMs: performance.now() - start,
      spans: spans.snapshot(),
    });
  }
}

/**
 * Time a background job and deliver it as a `job` transaction. The callback
 * receives a `SpanCollector`; errors reported while it runs carry the job's
 * transaction id.
 */
async function trackJob<T>(
  jobClass: string,
  operation: (spans: SpanCollector) => Promise<T> | T,
  meta: { queue?: string; environment?: string } = {},
): Promise<T> {
  const spans = new SpanCollector();
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const id = newTransactionId();
  const done = collectSpans(id, spans);
  try {
    return await runInTransaction(id, () => operation(spans));
  } finally {
    done();
    void notifyTransaction({
      id,
      kind: "job",
      jobClass,
      queue: meta.queue ?? "default",
      environment: meta.environment,
      occurredAt: startedAt,
      durationMs: performance.now() - start,
      spans: spans.snapshot(),
    });
  }
}

/**
 * Report a sign-in to this app: "success", "failure", "password_reset",
 * "mfa_failure" or "locked". Pass `req` for its IP, user agent and path.
 * Needs `authEvents: true` in `init`.
 */
function signIn(outcome: SignInOutcome, options: SignInOptions = {}): Promise<DeliveryResult> {
  return runtimeState().client.signIn(outcome, options);
}

/**
 * Record a release with errorgap (Deploys). Call it from a deploy script, or
 * set `trackRelease: true` to record it when the first error is reported.
 */
function trackRelease(
  release: { version?: string; sha?: string; branch?: string; environment?: string } = {},
): Promise<DeliveryResult> {
  return runtimeState().client.trackRelease(release);
}

function flush(): Promise<void> {
  return runtimeState().client.flush();
}

function getConfiguration(): Configuration {
  return runtimeState().configuration;
}

function getClient(): Client {
  return runtimeState().client;
}

export const Errorgap = {
  init,
  notify,
  notifyTransaction,
  trackTransaction,
  trackJob,
  signIn,
  trackRelease,
  currentTransactionId,
  runInTransaction,
  flush,
  configuration: getConfiguration,
  client: getClient,
  VERSION,
};

export { init, notify, notifyTransaction, trackTransaction, trackJob, signIn, trackRelease, flush };
