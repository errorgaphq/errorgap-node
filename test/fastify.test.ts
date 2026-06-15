import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { AddressInfo } from "node:net";
import Fastify from "fastify";
import { Errorgap } from "../src/index.js";
import { errorgapPlugin } from "../src/fastify.js";

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
