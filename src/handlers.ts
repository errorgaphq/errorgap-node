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

export function installProcessHandlers(client: Client): void {
  const state = processHandlerState();
  if (state.installed) return;
  state.installed = true;

  state.uncaughtHandler = (err: Error) => {
    void client.notify(err, {
      sync: true,
      context: { source: "uncaughtException" },
    });
  };

  state.rejectionHandler = (reason: unknown) => {
    void client.notify(reason, {
      sync: true,
      context: { source: "unhandledRejection" },
    });
  };

  process.on("uncaughtException", state.uncaughtHandler);
  process.on("unhandledRejection", state.rejectionHandler);
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
