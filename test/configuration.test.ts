import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Configuration } from "../src/configuration.js";

const ENV_KEYS = [
  "ERRORGAP_ENDPOINT",
  "ERRORGAP_PROJECT_SLUG",
  "ERRORGAP_PROJECT_ID",
  "ERRORGAP_API_KEY",
];

describe("Configuration", () => {
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      original[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = original[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("uses defaults when nothing is provided", () => {
    const config = new Configuration();
    expect(config.endpoint).toBe("http://127.0.0.1:3030");
    expect(config.async).toBe(true);
    expect(config.filterKeys).toContain("password");
    expect(config.filterKeys).toContain("authorization");
  });

  it("reads from environment variables", () => {
    process.env.ERRORGAP_ENDPOINT = "https://errorgap.example.com";
    process.env.ERRORGAP_PROJECT_SLUG = "demo";
    process.env.ERRORGAP_PROJECT_ID = "p_123";
    process.env.ERRORGAP_API_KEY = "flk_test";
    const config = new Configuration();
    expect(config.endpoint).toBe("https://errorgap.example.com");
    expect(config.projectSlug).toBe("demo");
    expect(config.projectId).toBe("p_123");
    expect(config.apiKey).toBe("flk_test");
  });

  it("explicit options override env", () => {
    process.env.ERRORGAP_PROJECT_SLUG = "from-env";
    const config = new Configuration({ projectSlug: "from-arg" });
    expect(config.projectSlug).toBe("from-arg");
  });

  it("validate throws when projectSlug missing", () => {
    const config = new Configuration();
    expect(() => config.validate()).toThrow(/projectSlug/);
  });

  it("validate passes when projectSlug present", () => {
    const config = new Configuration({ projectSlug: "demo" });
    expect(() => config.validate()).not.toThrow();
  });
});
