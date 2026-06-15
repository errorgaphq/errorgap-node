import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { AddressInfo } from "node:net";
import { Configuration } from "../src/configuration.js";
import { Client } from "../src/client.js";

interface CapturedRequest {
  url: string | undefined;
  method: string | undefined;
  headers: NodeJS.Dict<string | string[]>;
  body: unknown;
}

function startFakeServer(status = 201, responseBody = '{"group_id":"g_1"}'): Promise<{
  server: Server;
  port: number;
  requests: CapturedRequest[];
}> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        // leave as raw string
      }
      requests.push({ url: req.url, method: req.method, headers: req.headers, body });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(responseBody);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, port, requests });
    });
  });
}

describe("Client.deliver", () => {
  let server: Server;
  let port: number;
  let requests: CapturedRequest[];

  beforeEach(async () => {
    ({ server, port, requests } = await startFakeServer());
  });

  afterEach(() => {
    server.close();
  });

  it("POSTs to /api/projects/:slug/notices with the canonical headers", async () => {
    const config = new Configuration({
      endpoint: `http://127.0.0.1:${port}`,
      projectSlug: "demo",
      apiKey: "flk_test",
      async: false,
    });
    const client = new Client(config);

    const result = await client.notify(new Error("test"), { sync: true });

    expect(result.status).toBe(201);
    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/api/projects/demo/notices");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers["x-errorgap-project-key"]).toBe("flk_test");
    expect(String(req.headers["user-agent"])).toMatch(/^errorgap-node\//);
  });

  it("sends the notice envelope", async () => {
    const config = new Configuration({
      endpoint: `http://127.0.0.1:${port}`,
      projectSlug: "demo",
      apiKey: "flk_test",
      async: false,
    });
    const client = new Client(config);

    await client.notify(new TypeError("boom"), { sync: true });

    const body = requests[0]!.body as Record<string, unknown>;
    expect(body).toHaveProperty("errors");
    expect(body).toHaveProperty("context");
    const firstError = (body.errors as Array<{ type: string; message: string }>)[0]!;
    expect(firstError.type).toBe("TypeError");
    expect(firstError.message).toBe("boom");
  });

  it("returns an error result when projectSlug is missing", async () => {
    const config = new Configuration({
      endpoint: `http://127.0.0.1:${port}`,
      apiKey: "flk_test",
      logger: null,
    });
    const client = new Client(config);

    const result = await client.notify(new Error("x"), { sync: true });
    expect(result.error).toBeDefined();
    expect(requests).toHaveLength(0);
  });

  it("returns queued=true and 202 when async", async () => {
    const config = new Configuration({
      endpoint: `http://127.0.0.1:${port}`,
      projectSlug: "demo",
      apiKey: "flk_test",
      async: true,
      logger: null,
    });
    const client = new Client(config);

    const result = await client.notify(new Error("x"));
    expect(result.queued).toBe(true);
    expect(result.status).toBe(202);
    await client.flush();
  });
});
