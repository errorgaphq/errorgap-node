import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { AddressInfo } from "node:net";
import { Errorgap, browserTraceId, currentTransactionId } from "../src/index.js";

interface CapturedRequest {
  url: string | undefined;
  body: Record<string, unknown>;
}

describe("APM", () => {
  let server: Server;
  let requests: CapturedRequest[];

  beforeEach(async () => {
    requests = [];
    server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        requests.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") });
        res.writeHead(201, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    const port = await new Promise<number>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
    );
    Errorgap.init({
      endpoint: `http://127.0.0.1:${port}`,
      projectSlug: "demo",
      async: false,
      captureGlobals: false,
      apmEnabled: true,
    });
  });

  afterEach(() => {
    server.close();
  });

  it("trackJob delivers a job transaction whose id errors carry", async () => {
    const seen = await Errorgap.trackJob(
      "ReceiptJob",
      async (spans) => {
        spans.external(12);
        await new Promise((resolve) => setTimeout(resolve, 5));
        await Errorgap.notify(new Error("smtp down"), { sync: true });
        return currentTransactionId();
      },
      { queue: "mailers" },
    );
    expect(currentTransactionId()).toBeUndefined();
    for (let i = 0; i < 100 && requests.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    await Errorgap.flush();

    const job = requests.find((r) => r.url?.endsWith("/transactions"))!.body;
    expect(job.kind).toBe("job");
    expect(job.job_class).toBe("ReceiptJob");
    expect(job.queue).toBe("mailers");
    expect(job.id).toBe(seen);
    const notice = requests.find((r) => r.url?.endsWith("/notices"))!.body;
    expect((notice.context as Record<string, unknown>).transaction_id).toBe(seen);
  });

  it("concurrent transactions never share an id", async () => {
    const ids = await Promise.all(
      [1, 2, 3].map((n) =>
        Errorgap.trackTransaction({ method: "GET", path: "/n", pathRaw: `/${n}` }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 10 - n));
          return currentTransactionId();
        }),
      ),
    );
    expect(new Set(ids).size).toBe(3);
    for (let i = 0; i < 100 && requests.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
    await Errorgap.flush();
  });

  it("transactions are dropped unless APM is enabled", async () => {
    Errorgap.init({ ...Errorgap.configuration(), apmEnabled: false, captureGlobals: false, logger: null });
    const result = await Errorgap.notifyTransaction({ durationMs: 1 }, { sync: true });
    expect(result.status).toBe(204);
  });

  it("browserTraceId accepts only UUIDs", () => {
    expect(browserTraceId(" 0192F3C4-7A1B-4C2D-9E3F-0123456789AB ")).toBe("0192f3c4-7a1b-4c2d-9e3f-0123456789ab");
    expect(browserTraceId(["0192f3c4-7a1b-4c2d-9e3f-0123456789ab"])).toBe("0192f3c4-7a1b-4c2d-9e3f-0123456789ab");
    expect(browserTraceId("not-a-uuid")).toBeUndefined();
    expect(browserTraceId(undefined)).toBeUndefined();
  });
});
