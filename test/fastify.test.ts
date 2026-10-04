import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { AddressInfo } from "node:net";
import Fastify from "fastify";
import { Errorgap } from "../src/index.js";
import { errorgapPlugin, requestSpans } from "../src/fastify.js";

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

describe("fastify plugin", () => {
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

  it("reports thrown errors with request context", async () => {
    const app = Fastify();
    await app.register(errorgapPlugin);
    app.get("/boom", async () => {
      throw new Error("kaboom");
    });

    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    await Errorgap.flush();

    expect(requests).toHaveLength(1);
    const body = requests[0]!.body;
    const firstError = (body.errors as Array<{ message: string }>)[0]!;
    expect(firstError.message).toBe("kaboom");

    await app.close();
  });
});

describe("fastify plugin (APM)", () => {
  let ingestor: Server;
  let requests: CapturedRequest[];

  beforeEach(async () => {
    let port: number;
    ({ server: ingestor, port, requests } = await startFakeIngestor());
    Errorgap.init({
      endpoint: `http://127.0.0.1:${port}`,
      projectSlug: "demo",
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

  it("records requests with route template, spans, trace, and linked errors", async () => {
    const app = Fastify();
    await app.register(errorgapPlugin);
    app.get("/orders/:id", async (request, reply) => {
      requestSpans(request)?.database("SELECT * FROM orders WHERE id = 7", 2);
      await new Promise((resolve) => setTimeout(resolve, 5));
      void Errorgap.notify(new Error("card declined"), { sync: true });
      reply.code(201);
      return "ok";
    });
    app.get("/boom/:id", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error("kaboom");
    });

    await app.inject({
      method: "GET",
      url: "/orders/7?x=1",
      headers: { "x-errorgap-trace": "0192F3C4-7A1B-4C2D-9E3F-0123456789AB" },
    });
    await app.inject({ method: "GET", url: "/boom/1", headers: { "x-errorgap-trace": "nope" } });
    await settle(4);
    await app.close();

    const transactions = requests.filter((r) => r.url?.endsWith("/transactions")).map((r) => r.body);
    const notices = requests.filter((r) => r.url?.endsWith("/notices")).map((r) => r.body);
    const ok = transactions.find((t) => t.path === "/orders/:id")!;
    const boom = transactions.find((t) => t.path === "/boom/:id")!;
    expect(ok.path_raw).toBe("/orders/7");
    expect(ok.status_code).toBe(201);
    expect(ok.trace_id).toBe("0192f3c4-7a1b-4c2d-9e3f-0123456789ab");
    expect((ok.spans as Array<Record<string, unknown>>)[0]!.sql).toBe("SELECT * FROM orders WHERE id = ?");
    expect(boom.status_code).toBe(500);
    expect(boom).not.toHaveProperty("trace_id");

    const byMessage = (m: string) =>
      notices.find((n) => (n.errors as Array<{ message: string }>)[0]!.message === m)!;
    expect((byMessage("card declined").context as Record<string, unknown>).transaction_id).toBe(ok.id);
    expect((byMessage("kaboom").context as Record<string, unknown>).transaction_id).toBe(boom.id);
  });
});
