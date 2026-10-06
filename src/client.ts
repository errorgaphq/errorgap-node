import type { Configuration } from "./configuration.js";
import { transactionPayload, type Transaction } from "./apm.js";
import { buildNotice, type NoticeContext, type NoticePayload } from "./notice.js";
import { currentTransactionId } from "./transaction-context.js";
import { VERSION } from "./version.js";
import { buildSignIn, signInPayload, type SignInOptions } from "./sign-ins.js";

export interface DeliveryResult {
  status?: number;
  body?: string;
  error?: unknown;
  queued?: boolean;
}

export class Client {
  private pending = new Set<Promise<unknown>>();

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
      const err = coerceError(error);
      const notice = buildNotice(err, this.configuration, withTransaction(options));

      if (options.sync || !this.configuration.async) {
        const p = this.deliver(notice);
        this.track(p);
        return await p;
      }

      // Fire and forget. Tracked so flush() can await it.
      this.track(this.deliver(notice));
      return { queued: true, status: 202 };
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
    if (!this.configuration.apmEnabled) return { status: 204 };
    const rate = this.configuration.apmSampleRate;
    if (!(rate >= 1 || (rate > 0 && Math.random() < rate))) return { status: 204 };

    const p = this.post("transactions", transactionPayload(transaction, this.configuration));
    this.track(p);
    if (options.sync || !this.configuration.async) return await p;
    return { queued: true, status: 202 };
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
    if (!this.configuration.authEvents) return { status: 204 };
    const event = buildSignIn(outcome, options);
    if (!event) {
      this.log(new Error(`unknown sign-in outcome ${JSON.stringify(outcome)}`));
      return { status: 204 };
    }
    const p = this.post("logins/web", signInPayload(event, this.configuration));
    this.track(p);
    if (options.sync || !this.configuration.async) return await p;
    return { queued: true, status: 202 };
  }

  /** Await every in-flight delivery. Use during graceful shutdown. */
  async flush(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all(Array.from(this.pending));
    }
  }

  private track(promise: Promise<unknown>): void {
    const wrapped = promise.catch(() => undefined);
    this.pending.add(wrapped);
    void wrapped.finally(() => this.pending.delete(wrapped));
  }

  async deliver(notice: NoticePayload): Promise<DeliveryResult> {
    return this.post("notices", notice);
  }

  private async post(resource: string, payload: unknown): Promise<DeliveryResult> {
    const url = projectUrl(this.configuration, resource);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": `errorgap-node/${VERSION}`,
    };
    if (this.configuration.apiKey) {
      headers["x-errorgap-project-key"] = this.configuration.apiKey;
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      const body = await safeBody(response);
      return { status: response.status, body };
    } catch (exception) {
      this.log(exception);
      return { error: exception };
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
