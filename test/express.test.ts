import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import { Errorgap } from "../src/index.js";
import { errorgapErrorHandler, errorgapRequestHandler, requestSpans } from "../src/express.js";

interface CapturedRequest {
  url: string | undefined;
  body: Record<string, unknown>;
}

function startFakeIngestor(): Promise<{
  server: Server;
  port: number;
  requests: CapturedRequest[];
}> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        url: req.url,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
      });
      res.writeHead(201, { "content-type": "application/json" });
      res.end('{"group_id":"g_1"}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, port, requests });
    });
  });
}

describe("express middleware", () => {
  let ingestor: Server;
  let port: number;
  let requests: CapturedRequest[];

  beforeEach(async () => {
    ({ server: ingestor, port, requests } = await startFakeIngestor());
    Errorgap.init({
      endpoint: `http://127.0.0.1:${port}`,
      projectSlug: "demo",
      apiKey: "flk_test",
      async: false,
      captureGlobals: false,
    });
  });

  afterEach(() => {
    ingestor.close();
  });

  it("reports thrown errors and includes request context", async () => {
    const app = express();
    app.use(express.json());
    app.get("/boom", (_req, _res) => {
      throw new Error("kaboom");
    });
    app.use(errorgapErrorHandler());

    await request(app).get("/boom?x=1").expect(500);
    await Errorgap.flush();

    expect(requests).toHaveLength(1);
    const body = requests[0]!.body;
    const firstError = (body.errors as Array<{ message: string }>)[0]!;
    expect(firstError.message).toBe("kaboom");
    const ctx = body.context as Record<string, unknown>;
    expect(ctx.action).toBe("GET");
    expect(String(ctx.url)).toContain("/boom");
  });

  it("shares explicit configuration across independently loaded package entrypoints", async () => {
    vi.resetModules();
    const { Errorgap: isolatedErrorgap } = await import("../src/index.js");
    isolatedErrorgap.init({
      endpoint: `http://127.0.0.1:${port}`,
      projectSlug: "demo",
      apiKey: "flk_test",
      environment: "production",
      async: false,
      captureGlobals: false,
    });

    vi.resetModules();
    const { errorgapErrorHandler: isolatedErrorHandler } = await import("../src/express.js");
    const app = express();
    app.get("/isolated", () => {
      throw new Error("isolated entrypoint");
    });
    app.use(isolatedErrorHandler());

    await request(app).get("/isolated").expect(500);
    await isolatedErrorgap.flush();

    expect(requests).toHaveLength(1);
    expect((requests[0]!.body.context as Record<string, unknown>).environment).toBe("production");
  });
});

describe("express request handler (APM)", () => {
  let ingestor: Server;
  let port: number;
  let requests: CapturedRequest[];

  beforeEach(async () => {
    ({ server: ingestor, port, requests } = await startFakeIngestor());
    Errorgap.init({
      endpoint: `http://127.0.0.1:${port}`,
      projectSlug: "demo",
      apiKey: "flk_test",
      async: false,
      captureGlobals: false,
      apmEnabled: true,
    });
  });

  afterEach(() => {
    ingestor.close();
  });

  async function settle(count: number): Promise<void> {
    for (let i = 0; i < 100 && requests.length < count; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await Errorgap.flush();
  }

  it("records the request with its route template, spans and browser trace", async () => {
    const app = express();
    app.use(errorgapRequestHandler());
    const orders = express.Router();
    orders.get("/:id", (_req, res) => {
      requestSpans(res)?.database("SELECT * FROM orders WHERE id = 7", 2.5);
      res.status(201).send("ok");
    });
    app.use("/orders", orders);

    await request(app)
      .get("/orders/7?x=1")
      .set("x-errorgap-trace", "0192F3C4-7A1B-4C2D-9E3F-0123456789AB")
      .expect(201);
    await request(app).get("/orders/8").set("x-errorgap-trace", "not-a-uuid").expect(201);
    await settle(2);

    const transactions = requests.filter((r) => r.url?.endsWith("/transactions"));
    expect(transactions).toHaveLength(2);
    const body = transactions[0]!.body;
    expect(body.kind).toBe("web");
    expect(body.method).toBe("GET");
    expect(body.path).toBe("/orders/:id");
    expect(body.path_raw).toBe("/orders/7");
    expect(body.status_code).toBe(201);
    expect(body.trace_id).toBe("0192f3c4-7a1b-4c2d-9e3f-0123456789ab");
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.id).not.toBe(body.trace_id);
    expect((body.spans as Array<Record<string, unknown>>)[0]!.sql).toBe("SELECT * FROM orders WHERE id = ?");
    expect(transactions[1]!.body).not.toHaveProperty("trace_id");
  });

  it("links errors raised during the request to its transaction", async () => {
    const app = express();
    app.use(errorgapRequestHandler());
    const api = express.Router();
    api.get("/boom/:id", async (_req, _res, next) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      void Errorgap.notify(new Error("card declined"), { sync: true });
      next(new Error("kaboom"));
    });
    app.use("/api", api);
    app.use(errorgapErrorHandler());

    await request(app).get("/api/boom/1").expect(500);
    await settle(3);

    const transaction = requests.find((r) => r.url?.endsWith("/transactions"))!;
    const notices = requests.filter((r) => r.url?.endsWith("/notices"));
    expect(notices).toHaveLength(2);
    for (const notice of notices) {
      expect((notice.body.context as Record<string, unknown>).transaction_id).toBe(transaction.body.id);
    }
    expect(transaction.body.status_code).toBe(500);
    expect(transaction.body.path).toBe("/api/boom/:id");
  });
});
