import type { Configuration } from "./configuration.js";
import { buildNotice, type NoticeContext, type NoticePayload } from "./notice.js";
import { VERSION } from "./version.js";

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
      const notice = buildNotice(err, this.configuration, options);

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
    const url = noticesUrl(this.configuration);
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
        body: JSON.stringify(notice),
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

function noticesUrl(configuration: Configuration): string {
  const base = configuration.endpoint.endsWith("/")
    ? configuration.endpoint.slice(0, -1)
    : configuration.endpoint;
  return `${base}/api/projects/${configuration.projectSlug}/notices`;
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
