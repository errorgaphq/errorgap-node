import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * The APM transaction the current async flow is running in, so errors
 * reported during it carry its id as `context.transaction_id` and errorgap
 * links each error to the request or job that raised it. Follows awaits,
 * never leaks into a concurrent request.
 *
 * Each package entry point (`.`, `./express`) is bundled separately, so the
 * storage lives on a global symbol: every copy must see the same one.
 */
const STORAGE_KEY = Symbol.for("@errorgap/node/transaction-storage");

function storage(): AsyncLocalStorage<string> {
  const runtimeGlobal = globalThis as typeof globalThis & Record<symbol, unknown>;
  let existing = runtimeGlobal[STORAGE_KEY] as AsyncLocalStorage<string> | undefined;
  if (!existing) {
    existing = new AsyncLocalStorage<string>();
    runtimeGlobal[STORAGE_KEY] = existing;
  }
  return existing;
}

/** The id of the transaction running now, if any. */
export function currentTransactionId(): string | undefined {
  return storage().getStore();
}

/** Run `operation` with `id` as the current transaction id. */
export function runInTransaction<T>(id: string, operation: () => T): T {
  return storage().run(id, operation);
}

/** A new random transaction id (a UUID). */
export function newTransactionId(): string {
  return randomUUID();
}
