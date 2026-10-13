import { describe, it, expect, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, request as httpRequest, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { SpanCollector } from "../src/apm.js";
import {
  collectSpans,
  currentSpans,
  instrumentHttp,
  instrumentMysql2,
  instrumentPg,
} from "../src/instrument.js";
import { runInTransaction } from "../src/transaction-context.js";

/** Stand-ins with the call shapes of the real drivers. */
class FakePgClient {
  query(_text: unknown, valuesOrCallback?: unknown, callback?: unknown): unknown {
    const done = typeof valuesOrCallback === "function" ? valuesOrCallback : callback;
    if (typeof done === "function") {
      setTimeout(() => (done as (e: null, r: object) => void)(null, { rows: [1] }), 5);
      return undefined;
    }
    return new Promise((resolve) => setTimeout(() => resolve({ rows: [1] }), 5));
  }
}
class FakeMysqlConnection {
  query(_sql: unknown, callback?: unknown): unknown {
    const emitter = new EventEmitter();
    setTimeout(() => {
      if (typeof callback === "function") (callback as (e: null, r: object) => void)(null, {});
      emitter.emit("end");
    }, 5);
    return emitter;
  }
  execute(sql: unknown, callback?: unknown): unknown {
    return this.query(sql, callback);
  }
}
instrumentPg({ Client: FakePgClient });
instrumentMysql2({ Connection: FakeMysqlConnection });

let server: Server | undefined;
afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
});

async function inTransaction<T>(id: string, operation: () => Promise<T>): Promise<SpanCollector> {
  const spans = new SpanCollector();
  const done = collectSpans(id, spans);
  try {
    await runInTransaction(id, operation);
  } finally {
    done();
  }
  return spans;
}

describe("automatic spans", () => {
  it("records pg queries made with promises, callbacks and query configs", async () => {
    const client = new FakePgClient();
    const spans = await inTransaction("t-pg", async () => {
      await client.query("SELECT * FROM orders WHERE id = 7");
      await new Promise((resolve) => client.query("SELECT 1", [], resolve));
      const result = (await client.query({ text: "SELECT name FROM users WHERE email = 'a@b.c'" })) as { rows: number[] };
      expect(result.rows).toEqual([1]); // the driver's own result still reaches the caller
    });
    expect(spans.snapshot().map((span) => [span.kind, span.sql])).toEqual([
      ["db", "SELECT * FROM orders WHERE id = ?"],
      ["db", "SELECT ?"],
      ["db", "SELECT name FROM users WHERE email = ?"],
    ]);
    expect(spans.snapshot()[0]!.durationMs).toBeGreaterThan(1);
  });

  it("records mysql2 query and execute, by callback or emitter", async () => {
    const connection = new FakeMysqlConnection();
    const spans = await inTransaction("t-mysql", async () => {
      await new Promise((resolve) => connection.query("SELECT 2", resolve));
      await new Promise((resolve) => (connection.execute({ sql: "UPDATE t SET a = 5" }) as EventEmitter).once("end", resolve));
    });
    expect(spans.snapshot().map((span) => span.sql)).toEqual(["SELECT ?", "UPDATE t SET a = ?"]);
  });

  it("records nothing outside a transaction and keeps concurrent ones apart", async () => {
    const client = new FakePgClient();
    await client.query("SELECT 'outside'");
    expect(currentSpans()).toBeUndefined();

    const [a, b] = await Promise.all([
      inTransaction("t-a", async () => void (await client.query("SELECT 'a' FROM a"))),
      inTransaction("t-b", async () => void (await client.query("SELECT 'b' FROM b"))),
    ]);
    expect(a.snapshot().map((span) => span.sql)).toEqual(["SELECT ? FROM a"]);
    expect(b.snapshot().map((span) => span.sql)).toEqual(["SELECT ? FROM b"]);
  });

  it("records outbound fetch and http calls, but not calls to errorgap itself", async () => {
    server = createServer((_req, res) => res.end("ok"));
    const port = await new Promise<number>((resolve) =>
      server!.listen(0, "127.0.0.1", () => resolve((server!.address() as AddressInfo).port)),
    );
    const origin = `http://127.0.0.1:${port}`;

    instrumentHttp("http://errorgap.invalid");
    const spans = await inTransaction("t-http", async () => {
      await (await fetch(`${origin}/a`)).text();
      await new Promise((resolve) => httpRequest(`${origin}/b`, (res) => res.resume().once("end", resolve)).end());
    });
    const labels = spans.snapshot().map((span) => [span.kind, span.function]);
    expect(labels).toContainEqual(["http", `GET 127.0.0.1:${port}`]);
    expect(labels.length).toBeGreaterThanOrEqual(2);

    instrumentHttp(origin); // now this server is "errorgap"
    const ignored = await inTransaction("t-ignored", async () => void (await (await fetch(`${origin}/c`)).text()));
    expect(ignored.snapshot()).toEqual([]);
  });
});
