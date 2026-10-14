import type { Client } from "./client.js";

interface ProcessHandlerState {
  installed: boolean;
  uncaughtHandler: ((err: Error) => void) | null;
  rejectionHandler: ((reason: unknown) => void) | null;
}

const PROCESS_HANDLER_STATE_KEY = Symbol.for("@errorgap/node/process-handler-state");

function processHandlerState(): ProcessHandlerState {
  const runtimeGlobal = globalThis as typeof globalThis & Record<symbol, unknown>;
  const existing = runtimeGlobal[PROCESS_HANDLER_STATE_KEY] as ProcessHandlerState | undefined;
  if (existing) return existing;

  const state: ProcessHandlerState = {
    installed: false,
    uncaughtHandler: null,
    rejectionHandler: null,
  };
  runtimeGlobal[PROCESS_HANDLER_STATE_KEY] = state;
  return state;
}

export interface ProcessHandlerOptions {
  /**
   * After reporting an uncaught exception or unhandled rejection, end the
   * process as Node would have (exit code 1) when no other listener is
   * handling it. Defaults to `true`.
   */
  exitOnUncaught?: boolean;
}

/** How long a crashing process waits for its last report. */
const EXIT_FLUSH_MS = 2000;

export function installProcessHandlers(client: Client, options: ProcessHandlerOptions = {}): void {
  const state = processHandlerState();
  if (state.installed) return;
  state.installed = true;
  const exitOnUncaught = options.exitOnUncaught ?? true;

  // Listening for these events turns off Node's own handling of them, which
  // is to print the error and exit. Report, then do that ourselves: a
  // process that keeps running after an uncaught exception is in an unknown
  // state.
  const report = (error: unknown, event: "uncaughtException" | "unhandledRejection") => {
    const sent = client
      .notify(error, { sync: true, context: { source: event } })
      .catch(() => undefined);
    if (!exitOnUncaught || process.listenerCount(event) > 1) return;
    if (event === "unhandledRejection" && !rejectionsAreFatal()) return;

    console.error(error);
    process.exitCode = 1;
    const deadline = new Promise((resolve) => setTimeout(resolve, EXIT_FLUSH_MS));
    void Promise.race([sent, deadline]).then(() => process.exit(1));
  };

  state.uncaughtHandler = (err: Error) => report(err, "uncaughtException");
  state.rejectionHandler = (reason: unknown) => report(reason, "unhandledRejection");

  process.on("uncaughtException", state.uncaughtHandler);
  process.on("unhandledRejection", state.rejectionHandler);
}

/** Node exits on an unhandled rejection unless started with `--unhandled-rejections=warn|none`. */
function rejectionsAreFatal(): boolean {
  const flags = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? "").split(/\s+/)];
  const mode = flags
    .map((flag) => flag.match(/^--unhandled-rejections=(.+)$/)?.[1])
    .find((value) => value !== undefined);
  return mode !== "warn" && mode !== "none";
}

export function uninstallProcessHandlers(): void {
  const state = processHandlerState();
  if (!state.installed) return;
  if (state.uncaughtHandler) process.off("uncaughtException", state.uncaughtHandler);
  if (state.rejectionHandler) process.off("unhandledRejection", state.rejectionHandler);
  state.uncaughtHandler = null;
  state.rejectionHandler = null;
  state.installed = false;
}
