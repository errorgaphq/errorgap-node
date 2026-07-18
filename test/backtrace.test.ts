import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import {
  MAX_SOURCE_LINE_CHARS,
  SOURCE_CONTEXT_RADIUS,
  parseBacktrace,
  sourceExcerpt,
} from "../src/backtrace.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("parseBacktrace", () => {
  it("returns an empty array when there is no stack", () => {
    const err = new Error("x");
    err.stack = undefined as unknown as string;
    expect(parseBacktrace(err, process.cwd())).toEqual([]);
  });

  it("parses V8-style frames", () => {
    const err = new Error("x");
    err.stack = [
      "Error: x",
      "    at handler (/app/src/handler.js:42:10)",
      "    at /app/src/index.js:9:5",
      "    at Object.<anonymous> (/app/node_modules/express/lib/router.js:100:1)",
    ].join("\n");

    const frames = parseBacktrace(err, "/app");
    expect(frames).toHaveLength(3);
    expect(frames[0]).toMatchObject({
      file: "src/handler.js",
      line: 42,
      function: "handler",
      in_app: true,
      index: 0,
    });
    expect(frames[1]).toMatchObject({
      file: "src/index.js",
      line: 9,
      function: undefined,
      in_app: true,
      index: 1,
    });
    expect(frames[2]?.in_app).toBe(false);
  });

  it("decodes file:// URLs", () => {
    const err = new Error("x");
    err.stack = [
      "Error: x",
      "    at boot (file:///app/src/boot.mjs:1:1)",
    ].join("\n");
    const frames = parseBacktrace(err, "/app");
    expect(frames[0]?.file).toBe("src/boot.mjs");
  });

  it("includes bounded source for readable application and vendor frames", () => {
    const root = mkdtempSync(join(tmpdir(), "errorgap-node-backtrace-"));
    tempDirectories.push(root);
    const appFile = join(root, "src", "app.ts");
    const vendorFile = join(root, "node_modules", "express", "router.js");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "node_modules", "express"), { recursive: true });
    writeFileSync(appFile, "function checkout() {\n  throw new Error('boom');\n}\n");
    writeFileSync(vendorFile, "function handle(req) {\n  return req.next();\n}\n");

    const error = new Error("boom");
    error.stack = [
      "Error: boom",
      `    at checkout (${appFile}:2:3)`,
      `    at handle (${vendorFile}:2:3)`,
    ].join("\n");

    const frames = parseBacktrace(error, root);
    expect(frames[0]?.in_app).toBe(true);
    expect(frames[0]?.source?.lines).toContain("  throw new Error('boom');");
    expect(frames[1]?.in_app).toBe(false);
    expect(frames[1]?.source?.lines).toContain("  return req.next();");
  });

  it("bounds source context and line length", () => {
    const root = mkdtempSync(join(tmpdir(), "errorgap-node-source-"));
    tempDirectories.push(root);
    const sourceFile = join(root, "large.js");
    writeFileSync(sourceFile, Array.from({ length: 30 }, () => "x".repeat(500)).join("\n"));

    const source = sourceExcerpt(sourceFile, 15);
    expect(source?.start_line).toBe(15 - SOURCE_CONTEXT_RADIUS);
    expect(source?.lines).toHaveLength(SOURCE_CONTEXT_RADIUS * 2 + 1);
    expect(source?.lines.every((line) => line.length === MAX_SOURCE_LINE_CHARS)).toBe(true);
  });
});
