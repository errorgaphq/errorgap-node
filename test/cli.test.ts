import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSourceMaps, parseArgs, runCli, type CliIo } from "../src/cli.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function io(respond: (call: Call) => Response, env: Record<string, string> = {}): CliIo & { calls: Call[]; lines: string[]; errors: string[] } {
  const calls: Call[] = [];
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    calls,
    lines,
    errors,
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
    env: { ERRORGAP_ENDPOINT: "https://errorgap.test/", ERRORGAP_PROJECT_SLUG: "demo", ERRORGAP_API_KEY: "egp_key", ...env },
    cwd: mkdtempSync(join(tmpdir(), "errorgap-cli-")),
    fetch: (async (url: string, init: RequestInit = {}) => {
      const call = {
        url: String(url),
        method: init.method ?? "GET",
        headers: init.headers as Record<string, string>,
        body: init.body ? init.body.toString() : "",
      };
      calls.push(call);
      return respond(call);
    }) as unknown as typeof fetch,
  };
}

describe("errorgap CLI", () => {
  it("parses commands, positionals and both flag styles", () => {
    expect(parseArgs(["sourcemaps", "dist", "--release", "abc", "--url-prefix=/assets", "--help"])).toEqual({
      command: "sourcemaps",
      positional: ["dist"],
      flags: { release: "abc", "url-prefix": "/assets", help: "true" },
    });
  });

  it("test sends a test error with the project key", async () => {
    const run = io(() => new Response('{"group_id":"g_1"}', { status: 201 }));
    expect(await runCli(["test"], run)).toBe(0);
    expect(run.calls[0]!.url).toBe("https://errorgap.test/api/projects/demo/notices");
    expect(run.calls[0]!.headers["x-errorgap-project-key"]).toBe("egp_key");
    expect(JSON.parse(run.calls[0]!.body).errors[0].type).toBe("ErrorgapInstallTest");
    expect(run.lines[0]).toContain("group g_1");
  });

  it("explains a refused key instead of pretending it worked", async () => {
    const run = io(() => new Response('{"error":"invalid project key"}', { status: 401 }));
    expect(await runCli(["test"], run)).toBe(1);
    expect(run.errors[0]).toContain("HTTP 401 (check the key)");
  });

  it("deploy records a release, preferring the upload key", async () => {
    const run = io(() => new Response("{}", { status: 201 }), { ERRORGAP_UPLOAD_KEY: "egu_secret" });
    expect(await runCli(["deploy", "--sha", "abc123", "--branch", "main"], run)).toBe(0);
    expect(run.calls[0]!.url).toBe("https://errorgap.test/api/projects/demo/releases");
    expect(run.calls[0]!.headers["x-errorgap-upload-key"]).toBe("egu_secret");
    expect(run.calls[0]!.headers["x-errorgap-project-key"]).toBeUndefined();
    expect(JSON.parse(run.calls[0]!.body)).toEqual({ version: "abc123", sha: "abc123", branch: "main", environment: "production" });
  });

  it("deploy refuses to record nothing", async () => {
    const run = io(() => new Response("{}", { status: 201 }));
    expect(await runCli(["deploy"], run)).toBe(1);
    expect(run.calls).toHaveLength(0);
  });

  it("sourcemaps uploads each map under the URL of its script and reports failures", async () => {
    const dist = mkdtempSync(join(tmpdir(), "errorgap-maps-"));
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "assets", "app.js.map"), '{"version":3}');
    writeFileSync(join(dist, "assets", "app.js"), "//");
    writeFileSync(join(dist, "vendor.js.map"), '{"version":3}');
    expect(findSourceMaps(dist)).toEqual(["assets/app.js.map", "vendor.js.map"]);

    const run = io((call) => new Response("{}", { status: call.url.includes("vendor") ? 500 : 200 }), {
      ERRORGAP_UPLOAD_KEY: "egu_secret",
    });
    expect(await runCli(["sourcemaps", dist, "--release", "abc123", "--url-prefix", "/static"], run)).toBe(1);
    expect(run.calls.map((call) => [call.method, call.url])).toEqual([
      ["PUT", "https://errorgap.test/api/projects/demo/sourcemaps?release=abc123&file=%2Fstatic%2Fassets%2Fapp.js"],
      ["PUT", "https://errorgap.test/api/projects/demo/sourcemaps?release=abc123&file=%2Fstatic%2Fvendor.js"],
    ]);
    expect(run.lines.at(-1)).toBe("1 uploaded, 1 failed (release abc123).");
  });

  it("sourcemaps needs the upload key", async () => {
    const run = io(() => new Response("{}"));
    expect(await runCli(["sourcemaps", ".", "--release", "r"], run)).toBe(1);
    expect(run.errors[0]).toContain("upload key");
  });

  it("settings shows the project's switches", async () => {
    const run = io(() => new Response('{"errors_enabled":true,"apm_enabled":false,"logs_enabled":true}', { status: 200 }));
    expect(await runCli(["settings"], run)).toBe(0);
    expect(run.lines).toEqual(["Errors       on", "Performance  off", "Logs         on"]);
  });

  it("says what is missing when nothing is configured", async () => {
    const run = io(() => new Response("{}"));
    run.env = {};
    expect(await runCli(["test"], run)).toBe(1);
    expect(run.errors[0]).toContain("ERRORGAP_ENDPOINT");
  });
});
