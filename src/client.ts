import type { Configuration } from "./configuration.js";
import { transactionPayload, type Transaction } from "./apm.js";
import { buildNotice, type NoticeContext, type NoticePayload } from "./notice.js";
import { currentTransactionId } from "./transaction-context.js";
import { VERSION } from "./version.js";
import { buildSignIn, signInPayload, type SignInOptions } from "./sign-ins.js";

import { Delivery, type DeliveryResult } from "./delivery.js";

export type { DeliveryResult } from "./delivery.js";

export class Client {
  private releaseRecorded = false;
  private delivery = new Delivery(() => ({
    endpoint: this.configuration.endpoint,
    projectSlug: this.configuration.projectSlug,
    apiKey: this.configuration.apiKey,
    timeout: this.configuration.timeout,
    queueSize: this.configuration.queueSize,
    userAgent: `errorgap-node/${VERSION}`,
    warn: (message) => this.configuration.logger?.warn(message),
  }));

  constructor(private configuration: Configuration) {}

  configure(configuration: Configuration): void {
    this.configuration = configuration;
  }

  async notify(
    error: unknown,
    options: NoticeContext & { sync?: boolean } = {},
  ): Promise<DeliveryResult> {
    try {
      this.configuration.validate();
      if (this.configuration.ignoredEnvironment()) return { status: 202, body: "ignored environment" };
      const err = coerceError(error);
      const notice = await this.runHook(
        buildNotice(err, this.configuration, withTransaction(options)),
      );
      if (!notice) return { status: 202, body: "dropped by beforeNotify" };

      if (this.configuration.trackRelease && !this.releaseRecorded) {
        this.releaseRecorded = true;
        void this.trackRelease({}, { sync: false });
      }
      if (options.sync || !this.configuration.async) return await this.deliver(notice);
      return this.delivery.enqueue("notices", notice);
    } catch (exception) {
      this.log(exception);
      return { error: exception };
    }
  }

  /**
   * Deliver an APM transaction (HTTP interaction or background job). Dropped
   * unless `apmEnabled`, and sampled by `apmSampleRate`.
   */
  async notifyTransaction(
    transaction: Transaction,
    options: { sync?: boolean } = {},
  ): Promise<DeliveryResult> {
    try {
      this.configuration.validate();
    } catch (exception) {
      this.log(exception);
      return { error: exception };
    }
    if (!this.configuration.apmEnabled || this.configuration.ignoredEnvironment()) return { status: 204 };
    const rate = this.configuration.apmSampleRate;
    if (!(rate >= 1 || (rate > 0 && Math.random() < rate))) return { status: 204 };

    const payload = transactionPayload(transaction, this.configuration);
    if (options.sync || !this.configuration.async) return await this.delivery.send("transactions", payload);
    return this.delivery.enqueue("transactions", payload);
  }

  /**
   * Report a sign-in to this app (Security › Logins). Dropped unless
   * `authEvents` is on, or when the outcome is unknown.
   */
  async signIn(outcome: string, options: SignInOptions = {}): Promise<DeliveryResult> {
    try {
      this.configuration.validate();
    } catch (exception) {
      this.log(exception);
      return { error: exception };
    }
    if (!this.configuration.authEvents || this.configuration.ignoredEnvironment()) return { status: 204 };
    const event = buildSignIn(outcome, options);
    if (!event) {
      this.log(new Error(`unknown sign-in outcome ${JSON.stringify(outcome)}`));
      return { status: 204 };
    }
    const payload = signInPayload(event, this.configuration);
    if (options.sync || !this.configuration.async) return await this.delivery.send("logins/web", payload);
    return this.delivery.enqueue("logins/web", payload);
  }

  /**
   * Record a release with errorgap (Deploys), so errors are attributed to
   * the deploy that shipped them. Defaults come from the configuration.
   */
  async trackRelease(
    release: { version?: string; sha?: string; branch?: string; environment?: string } = {},
    options: { sync?: boolean } = {},
  ): Promise<DeliveryResult> {
    try {
      this.configuration.validate();
    } catch (exception) {
      this.log(exception);
      return { error: exception };
    }
    if (this.configuration.ignoredEnvironment()) return { status: 204 };
    const payload: Record<string, string> = {};
    const fields = {
      version: release.version ?? this.configuration.release,
      sha: release.sha ?? this.configuration.releaseSha,
      branch: release.branch ?? this.configuration.releaseBranch,
      environment: release.environment ?? this.configuration.environment,
    };
    for (const [key, value] of Object.entries(fields)) {
      if (value) payload[key] = value;
    }
    if (!payload.version && !payload.sha) return { status: 204 };
    if (options.sync === false) return this.delivery.enqueue("releases", payload);
    return await this.delivery.send("releases", payload);
  }

  /** Await everything queued or being sent. Use during graceful shutdown. */
  async flush(): Promise<void> {
    await this.delivery.flush();
  }

  async deliver(notice: NoticePayload): Promise<DeliveryResult> {
    return this.delivery.send("notices", notice);
  }

  /**
   * A hook that throws is logged and skipped: a bug in a filter must not
   * lose the error it was filtering.
   */
  private async runHook(notice: NoticePayload): Promise<NoticePayload | null> {
    const hook = this.configuration.beforeNotify;
    if (!hook) return notice;
    try {
      const result = await hook(notice);
      if (result === false || result === null) return null;
      return result && typeof result === "object" && Array.isArray(result.errors) ? result : notice;
    } catch (exception) {
      this.log(exception);
      return notice;
    }
  }

  private log(exception: unknown): void {
    const logger = this.configuration.logger;
    if (!logger) return;
    const message =
      exception instanceof Error
        ? `${exception.name}: ${exception.message}`
        : String(exception);
    logger.warn(`[errorgap] ${message}`);
  }
}

function projectUrl(configuration: Configuration, resource: string): string {
  const base = configuration.endpoint.endsWith("/")
    ? configuration.endpoint.slice(0, -1)
    : configuration.endpoint;
  return `${base}/api/projects/${configuration.projectSlug}/${resource}`;
}

async function safeBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function coerceError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  if (error && typeof error === "object") {
    const obj = error as { message?: unknown; name?: unknown };
    const err = new Error(typeof obj.message === "string" ? obj.message : JSON.stringify(error));
    if (typeof obj.name === "string") err.name = obj.name;
    return err;
  }
  return new Error(String(error));
}

/** Errors reported inside a transaction carry its id, unless set explicitly. */
function withTransaction<T extends NoticeContext>(options: T): T {
  const id = currentTransactionId();
  if (!id || (options.context && "transaction_id" in options.context)) return options;
  return { ...options, context: { ...(options.context ?? {}), transaction_id: id } };
}
