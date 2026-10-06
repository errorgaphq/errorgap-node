import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Configuration } from "../src/configuration.js";
import { Client } from "../src/client.js";
import { buildSignIn } from "../src/sign-ins.js";

const expressReq = {
  ip: "198.51.100.71",
  method: "POST",
  originalUrl: "/users/sign_in?next=/admin&token=abc",
  headers: { "user-agent": "Safari 18", cookie: "sid=secret" },
};

describe("buildSignIn", () => {
  it("reads the IP, user agent and path from a request, without the query", () => {
    const e = buildSignIn("success", { user: "mara@oxcoffee.com", req: expressReq })!;
    expect(e).toMatchObject({
      outcome: "success",
      user: "mara@oxcoffee.com",
      ip: "198.51.100.71",
      user_agent: "Safari 18",
      path: "POST /users/sign_in",
    });
    expect(JSON.stringify(e)).not.toContain("secret");
  });

  it("falls back to the socket address for a plain Node request", () => {
    const e = buildSignIn("failure", {
      req: { method: "POST", url: "/login", headers: {}, socket: { remoteAddress: "203.0.113.9" } },
    })!;
    expect([e.ip, e.path, e.user]).toEqual(["203.0.113.9", "POST /login", undefined]);
  });

  it("drops unknown outcomes", () => {
    expect(buildSignIn("teleported", {})).toBeNull();
  });
});

describe("Client.signIn", () => {
  let server: Server;
  afterEach(() => {
    server?.close();
  });

  async function capture() {
    const bodies: { url: string | undefined; key: unknown; body: any }[] = [];
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        bodies.push({ url: req.url, key: req.headers["x-errorgap-project-key"], body: JSON.parse(raw) });
        res.writeHead(202);
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    return { port: (server.address() as AddressInfo).port, bodies };
  }

  it("posts to /logins/web with the project key, once opted in", async () => {
    const { port, bodies } = await capture();
    const base = { endpoint: `http://127.0.0.1:${port}`, projectSlug: "ox-coffee", apiKey: "k1", async: false, environment: "production" };

    expect((await new Client(new Configuration(base)).signIn("success", { user: "x" })).status).toBe(204);
    expect(bodies).toHaveLength(0);

    const client = new Client(new Configuration({ ...base, authEvents: true, appName: "oxcoffee-web" }));
    const result = await client.signIn("locked", { user: "admin", req: expressReq });
    expect(result.status).toBe(202);
    expect(bodies[0]!.url).toBe("/api/projects/ox-coffee/logins/web");
    expect(bodies[0]!.key).toBe("k1");
    expect(bodies[0]!.body).toMatchObject({
      app: "oxcoffee-web",
      environment: "production",
      events: [{ outcome: "locked", user: "admin", ip: "198.51.100.71" }],
    });
    expect(bodies[0]!.body.sdk).toMatch(/^errorgap-node /);
  });
});
