import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import { Errorgap } from "../src/index.js";
import { errorgapErrorHandler } from "../src/express.js";

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
