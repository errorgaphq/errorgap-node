export interface Logger {
  warn(message: string, ...args: unknown[]): void;
  error?(message: string, ...args: unknown[]): void;
}

import type { FilterKey } from "./filter.js";
import type { NoticePayload } from "./notice.js";
import { detectRelease } from "./release.js";

/**
 * Sees each notice before it is sent. Change it in place or return a
 * replacement; return `false` or `null` to drop it.
 */
export type BeforeNotify = (
  notice: NoticePayload,
) => NoticePayload | false | null | void | Promise<NoticePayload | false | null | void>;

export interface ConfigurationInput {
  endpoint?: string;
  projectSlug?: string;
  projectId?: string;
  apiKey?: string;
  environment?: string;
  rootDirectory?: string;
  async?: boolean;
  logger?: Logger | null;
  /** Substrings (case-insensitive) or regexps; matching keys are masked at any depth. */
  filterKeys?: FilterKey[];
  /**
   * The deployed version or commit. Defaults to `ERRORGAP_RELEASE`, the
   * hosting platform's commit variable, then the git checkout.
   */
  release?: string;
  /** Commit and branch recorded with the release by `trackRelease`. */
  releaseSha?: string;
  releaseBranch?: string;
  /** Record the release with errorgap when the first error is reported. */
  trackRelease?: boolean;
  /** Environments in which nothing is sent. Defaults to `ERRORGAP_IGNORE_ENVIRONMENTS`. */
  ignoreEnvironments?: string[];
  /** Seconds allowed for each request to errorgap. Default 5. */
  timeout?: number;
  /** Payloads held for sending; the oldest is dropped when full. Default 100. */
  queueSize?: number;
  beforeNotify?: BeforeNotify;
  /**
   * Follow the project's settings in errorgap (Project settings › What SDKs
   * send): stop sending errors or performance data when they are switched
   * off there. Defaults to true; `ERRORGAP_REMOTE_SETTINGS=false` turns it off.
   */
  remoteSettings?: boolean;
  apmEnabled?: boolean;
  /**
   * With APM on, record SQL queries (`pg`, `mysql2`, `mysql`) and outbound
   * HTTP calls as spans automatically. Defaults to true.
   */
  autoInstrument?: boolean;
  apmSampleRate?: number;
  /** Report sign-ins (`signIn`). Off by default: events carry user names and IPs. */
  authEvents?: boolean;
  /** The app's name in Security › Logins. Defaults to the project slug. */
  appName?: string;
}

const DEFAULT_FILTER_KEYS = [
  "password",
  "password_confirmation",
  "token",
  "secret",
  "api_key",
  "authorization",
  "cookie",
];

export class Configuration {
  endpoint: string;
  projectSlug: string | undefined;
  projectId: string | undefined;
  apiKey: string | undefined;
  environment: string;
  rootDirectory: string;
  async: boolean;
  logger: Logger | null;
  filterKeys: FilterKey[];
  release: string | undefined;
  releaseSha: string | undefined;
  releaseBranch: string | undefined;
  trackRelease: boolean;
  ignoreEnvironments: string[];
  timeout: number;
  queueSize: number;
  beforeNotify: BeforeNotify | undefined;
  remoteSettings: boolean;
  apmEnabled: boolean;
  autoInstrument: boolean;
  apmSampleRate: number;
  authEvents: boolean;
  appName: string | undefined;

  constructor(input: ConfigurationInput = {}) {
    this.endpoint =
      input.endpoint ?? process.env.ERRORGAP_ENDPOINT ?? "http://127.0.0.1:3030";
    this.projectSlug = input.projectSlug ?? process.env.ERRORGAP_PROJECT_SLUG;
    this.projectId = input.projectId ?? process.env.ERRORGAP_PROJECT_ID;
    this.apiKey = input.apiKey ?? process.env.ERRORGAP_API_KEY;
    this.environment =
      input.environment ?? process.env.NODE_ENV ?? "development";
    this.rootDirectory = input.rootDirectory ?? process.cwd();
    this.async = input.async ?? true;
    this.logger = input.logger === undefined ? console : input.logger;
    this.filterKeys = input.filterKeys ?? [...DEFAULT_FILTER_KEYS];
    this.release = input.release ?? detectRelease(this.rootDirectory);
    this.releaseSha = input.releaseSha;
    this.releaseBranch = input.releaseBranch;
    this.trackRelease = input.trackRelease ?? false;
    this.ignoreEnvironments =
      input.ignoreEnvironments ??
      (process.env.ERRORGAP_IGNORE_ENVIRONMENTS ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
    this.timeout = input.timeout ?? 5;
    this.queueSize = input.queueSize ?? 100;
    this.beforeNotify = input.beforeNotify;
    this.remoteSettings =
      input.remoteSettings ?? (process.env.ERRORGAP_REMOTE_SETTINGS ?? "").trim().toLowerCase() !== "false";
    this.apmEnabled = input.apmEnabled ?? false;
    this.autoInstrument = input.autoInstrument ?? true;
    this.apmSampleRate = input.apmSampleRate ?? 1.0;
    this.authEvents = input.authEvents ?? false;
    this.appName = input.appName ?? process.env.ERRORGAP_APP_NAME;
  }

  ignoredEnvironment(): boolean {
    return this.ignoreEnvironments.includes(this.environment);
  }

  validate(): void {
    if (!this.projectSlug || this.projectSlug.trim().length === 0) {
      throw new Error("Errorgap projectSlug is required");
    }
  }
}
