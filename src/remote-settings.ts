import type { Configuration } from "./configuration.js";
import { VERSION } from "./version.js";

export type RemoteKind = "errors" | "apm" | "logs";

const FIELDS: Record<RemoteKind, string> = {
  errors: "errors_enabled",
  apm: "apm_enabled",
  logs: "logs_enabled",
};
const DEFAULT_INTERVAL_S = 600;
const MIN_INTERVAL_S = 60;

/**
 * The project's remote settings: what errorgap wants this app to send.
 * Someone can turn errors or performance data off for a project in errorgap
 * (Project settings › What SDKs send) and running apps follow within a poll
 * interval, with no deploy.
 *
 * Read from `GET /api/projects/:slug/config` in the background. Until the
 * first answer, and whenever errorgap cannot be reached, everything stays on.
 */
export class RemoteSettings {
  private settings: Record<string, unknown> = {};
  private intervalSeconds = DEFAULT_INTERVAL_S;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;

  constructor(private configuration: () => Configuration) {}

  /** False only when errorgap has said to stop sending this kind of data. */
  enabled(kind: RemoteKind): boolean {
    const configuration = this.configuration();
    if (!configuration.remoteSettings) return true;
    this.start();
    return this.settings[FIELDS[kind]] !== false;
  }

  /** Fetch now. Resolves with whether the settings could be read. */
  async refresh(): Promise<boolean> {
    const configuration = this.configuration();
    if (!configuration.projectSlug) return false;
    const base = configuration.endpoint.endsWith("/") ? configuration.endpoint.slice(0, -1) : configuration.endpoint;
    const headers: Record<string, string> = { "user-agent": `errorgap-node/${VERSION}` };
    if (configuration.apiKey) headers["x-errorgap-project-key"] = configuration.apiKey;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), (configuration.timeout > 0 ? configuration.timeout : 5) * 1000);
    try {
      const response = await fetch(`${base}/api/projects/${configuration.projectSlug}/config`, {
        headers,
        signal: controller.signal,
      });
      if (response.status !== 200) return false;
      const body = (await response.json()) as Record<string, unknown> | null;
      if (!body || typeof body !== "object") return false;
      this.settings = body;
      const seconds = Number(body.poll_interval_seconds);
      this.intervalSeconds = Number.isFinite(seconds) && seconds >= MIN_INTERVAL_S ? seconds : DEFAULT_INTERVAL_S;
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Stop polling (tests, or a reconfigured client). */
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.started = false;
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    const poll = () => {
      void this.refresh().finally(() => {
        if (!this.started) return;
        this.timer = setTimeout(poll, this.intervalSeconds * 1000);
        // Polling must not keep a finished process alive.
        (this.timer as { unref?: () => void }).unref?.();
      });
    };
    poll();
  }
}
