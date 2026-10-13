import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Configuration } from "../src/configuration.js";
import { Client } from "../src/client.js";
import { Delivery, RateLimitedError, retryable, type DeliverySettings } from "../src/delivery.js";
import { filterParams } from "../src/filter.js";
import { buildNotice } from "../src/notice.js";
import { detectRelease } from "../src/release.js";
import { installProcessHandlers, uninstallProcessHandlers } from "../src/handlers.js";

let server: Server | undefined;

/** Answers each request with the next scripted [status, headers] pair. */
function stub(responses: Array<[number, Record<string, string>?]>): Promise<{ port: number; bodies: unknown[] }> {
  const bodies: unknown[] = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"));
      const [status, headers] = responses.length > 1 ? responses.shift()! : responses[0]!;
      res.writeHead(status, headers ?? {});
      res.end("{}");
    });
  });
  return new Promise((resolve) =>
    server!.listen(0, "127.0.0.1", () => resolve({ port: (server!.address() as AddressInfo).port, bodies })),
  );
}

function settings(port: number, overrides: Partial<DeliverySettings> = {}): () => DeliverySettings {
  return () => ({
    endpoint: `http://127.0.0.1:${port}`,
    projectSlug: "demo",
    apiKey: "k",
    timeout: 2,
    queueSize: 100,
    userAgent: "errorgap-node/test",
    warn: () => undefined,
    ...overrides,
  });
}

afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
  uninstallProcessHandlers();
  vi.restoreAllMocks();
});

describe("Delivery", () => {
  it("sends queued payloads and flush waits for them", async () => {
    const { port, bodies } = await stub([[201]]);
    const delivery = new Delivery(settings(port));
    for (let n = 0; n < 6; n++) delivery.enqueue("notices", { n });
    await delivery.flush();
    expect(bodies).toHaveLength(6);
  });

  it("pauses after a 429 for Retry-After and sends nothing meanwhile", async () => {
    const { port, bodies } = await stub([[429, { "retry-after": "120" }]]);
    const delivery = new Delivery(settings(port));
    expect((await delivery.send("notices", {})).status).toBe(429);
    expect(delivery.paused()).toBe(true);
    expect((await delivery.send("notices", {})).error).toBeInstanceOf(RateLimitedError);
    expect(bodies).toHaveLength(1);
  });

  it("retries network failures and 5xx, not 4xx or rate limits", () => {
    expect(retryable({ status: 500 })).toBe(true);
    expect(retryable({ error: new Error("ECONNREFUSED") })).toBe(true);
    expect(retryable({ status: 422 })).toBe(false);
    expect(retryable({ status: 429 })).toBe(false);
    expect(retryable({ error: new RateLimitedError() })).toBe(false);
  });

  it("drops the oldest queued payload when the queue is full", async () => {
    const { port, bodies } = await stub([[201]]);
    const delivery = new Delivery(settings(port, { queueSize: 2 }));
    // Four go out at once; of the next three only the newest two fit.
    for (let n = 0; n < 7; n++) delivery.enqueue("notices", { n });
    await delivery.flush();
    expect((bodies as Array<{ n: number }>).map((body) => body.n).sort()).toEqual([0, 1, 2, 3, 5, 6]);
  });

  it("gives up on a request after the timeout", async () => {
    server = createServer(() => undefined); // never answers
    const port = await new Promise<number>((resolve) =>
      server!.listen(0, "127.0.0.1", () => resolve((server!.address() as AddressInfo).port)),
    );
    const delivery = new Delivery(settings(port, { timeout: 0.1 }));
    const result = await delivery.send("notices", {});
    expect(result.error).toBeDefined();
    server.closeAllConnections();
  });
});

describe("filterParams", () => {
  it("masks keys inside arrays and survives cycles, bigints and huge values", () => {
    const loop: Record<string, unknown> = { name: "a" };
    loop.self = loop;
    const out = filterParams(
      { users: [{ password: "x", ssn: "1" }], loop, big: 10n, long: "x".repeat(10_000) },
      ["password", /^ssn$/],
    ) as any;
    expect(out.users[0]).toEqual({ password: "[FILTERED]", ssn: "[FILTERED]" });
    expect(out.loop.self).toBe("[CIRCULAR]");
    expect(out.big).toBe("10");
    expect(out.long.endsWith("[TRUNCATED]")).toBe(true);
    expect(() => JSON.stringify(out)).not.toThrow();
  });
});

describe("notices", () => {
  const config = () => new Configuration({ projectSlug: "demo", release: "v9", logger: null });

  it("carry the cause chain, the user and the release", () => {
    const error = new Error("outer", { cause: new TypeError("inner") });
    const notice = buildNotice(error, config(), {
      user: { id: 7, email: "ada@example.com" },
      session: { token: "t" },
    });
    expect(notice.context.causes).toEqual([{ type: "TypeError", message: "inner" }]);
    expect(notice.context.release).toBe("v9");
    expect(notice.session).toEqual({ user_id: "7", user_email: "ada@example.com", token: "[FILTERED]" });
    expect(notice.errors[0]!.backtrace.map((frame) => frame.index)).toEqual(
      notice.errors[0]!.backtrace.map((_, index) => index),
    );
  });

  it("can be changed or dropped by beforeNotify, and a throwing hook is skipped", async () => {
    const { port, bodies } = await stub([[201]]);
    const client = (beforeNotify: Configuration["beforeNotify"]) =>
      new Client(
        new Configuration({ projectSlug: "demo", endpoint: `http://127.0.0.1:${port}`, logger: null, beforeNotify }),
      );

    const dropped = await client(() => false).notify(new Error("no"), { sync: true });
    expect(dropped.body).toBe("dropped by beforeNotify");
    await client((notice) => {
      notice.context.team = "billing";
    }).notify(new Error("yes"), { sync: true });
    await client(() => {
      throw new Error("bug in the hook");
    }).notify(new Error("still sent"), { sync: true });

    expect((bodies as any[]).map((body) => body.errors[0].message)).toEqual(["yes", "still sent"]);
    expect((bodies as any[])[0].context.team).toBe("billing");
  });

  it("are not sent in an ignored environment", async () => {
    const client = new Client(
      new Configuration({ projectSlug: "demo", environment: "test", ignoreEnvironments: ["test"], logger: null }),
    );
    expect((await client.notify(new Error("x"), { sync: true })).body).toBe("ignored environment");
  });
});

describe("detectRelease", () => {
  it("prefers the platform variable, then reads .git/HEAD", () => {
    const root = mkdtempSync(join(tmpdir(), "errorgap-"));
    expect(detectRelease(root, {})).toBeUndefined();
    mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(root, ".git", "packed-refs"), `# pack-refs\n${"b".repeat(40)} refs/heads/main\n`);
    expect(detectRelease(root, {})).toBe("b".repeat(40));
    writeFileSync(join(root, ".git", "refs", "heads", "main"), `${"a".repeat(40)}\n`);
    expect(detectRelease(root, {})).toBe("a".repeat(40));
    expect(detectRelease(root, { SOURCE_VERSION: "env1" })).toBe("env1");
  });
});

describe("process handlers", () => {
  const fakeClient = () => ({ notify: vi.fn().mockResolvedValue({ status: 201 }) }) as unknown as Client;

  it("report an uncaught exception, then exit with code 1 as Node would", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // The test runner listens too; without it errorgap is the only listener.
    const runner = process.listeners("uncaughtException");
    process.removeAllListeners("uncaughtException");
    const client = fakeClient();
    installProcessHandlers(client);
    const error = new Error("boom");
    try {
      process.listeners("uncaughtException").at(-1)!(error, "uncaughtException");
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    } finally {
      for (const listener of runner) process.on("uncaughtException", listener);
      process.exitCode = 0;
    }
    expect(client.notify).toHaveBeenCalledWith(error, expect.objectContaining({ sync: true }));
  });

  it("leave the exit to the app when it has its own listener or opted out", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const own = () => undefined;
    process.on("uncaughtException", own);
    const client = fakeClient();
    installProcessHandlers(client);
    process.listeners("uncaughtException").at(-1)!(new Error("boom"), "uncaughtException");
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off("uncaughtException", own);
    expect(client.notify).toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
