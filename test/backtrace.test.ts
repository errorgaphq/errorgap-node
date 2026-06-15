import { describe, it, expect } from "vitest";
import { parseBacktrace } from "../src/backtrace.js";

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
});
