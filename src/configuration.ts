export interface Logger {
  warn(message: string, ...args: unknown[]): void;
  error?(message: string, ...args: unknown[]): void;
}

export interface ConfigurationInput {
  endpoint?: string;
  projectSlug?: string;
  projectId?: string;
  apiKey?: string;
  environment?: string;
  rootDirectory?: string;
  async?: boolean;
  logger?: Logger | null;
  filterKeys?: string[];
  apmEnabled?: boolean;
  apmSampleRate?: number;
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
  filterKeys: string[];
  apmEnabled: boolean;
  apmSampleRate: number;

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
    this.apmEnabled = input.apmEnabled ?? false;
    this.apmSampleRate = input.apmSampleRate ?? 1.0;
  }

  validate(): void {
    if (!this.projectSlug || this.projectSlug.trim().length === 0) {
      throw new Error("Errorgap projectSlug is required");
    }
  }
}
