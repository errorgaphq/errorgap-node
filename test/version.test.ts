import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

describe("VERSION", () => {
  it("matches the published package version", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      version: string;
    };

    expect(VERSION).toBe(packageJson.version);
  });
});
