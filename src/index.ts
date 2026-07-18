import { Configuration, type ConfigurationInput } from "./configuration.js";
import { Client, type DeliveryResult } from "./client.js";
import { installProcessHandlers, uninstallProcessHandlers } from "./handlers.js";
import type { NoticeContext } from "./notice.js";
import { VERSION } from "./version.js";

export type { ConfigurationInput, Logger } from "./configuration.js";
export type { NoticeContext, NoticePayload } from "./notice.js";
export type { BacktraceFrame } from "./backtrace.js";
export type { DeliveryResult } from "./client.js";
export { Configuration } from "./configuration.js";
export { Client } from "./client.js";
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
}

function init(options: InitOptions = {}): void {
  const { captureGlobals = true, ...rest } = options;
  const state = runtimeState();
  state.configuration = new Configuration(rest);
  state.client.configure(state.configuration);
  if (captureGlobals) {
    installProcessHandlers(state.client);
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
  flush,
  configuration: getConfiguration,
  client: getClient,
  VERSION,
};

export { init, notify, flush };
