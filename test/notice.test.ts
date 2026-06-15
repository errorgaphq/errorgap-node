import { describe, it, expect } from "vitest";
import { Configuration } from "../src/configuration.js";
import { buildNotice } from "../src/notice.js";
import { VERSION } from "../src/version.js";

describe("buildNotice", () => {
  const config = new Configuration({ projectSlug: "demo", projectId: "p_1", environment: "test" });

  it("captures type and message from an Error", () => {
    const err = new TypeError("boom");
    const notice = buildNotice(err, config);
    expect(notice.errors[0]?.type).toBe("TypeError");
    expect(notice.errors[0]?.message).toBe("boom");
  });

  it("includes notifier identification in context", () => {
    const notice = buildNotice(new Error("x"), config);
    expect(notice.context.notifier).toBe("errorgap-node");
    expect(notice.context.notifier_version).toBe(VERSION);
    expect(notice.context.environment).toBe("test");
  });

  it("merges custom context over defaults", () => {
    const notice = buildNotice(new Error("x"), config, {
      context: { component: "billing" },
    });
    expect(notice.context.component).toBe("billing");
    expect(notice.context.notifier).toBe("errorgap-node");
  });

  it("filters sensitive params", () => {
    const notice = buildNotice(new Error("x"), config, {
      params: {
        username: "alice",
        password: "hunter2",
        nested: { auth_token: "abc", safe: "ok" },
      },
    });
    expect(notice.params.username).toBe("alice");
    expect(notice.params.password).toBe("[FILTERED]");
    expect((notice.params.nested as Record<string, unknown>).auth_token).toBe("[FILTERED]");
    expect((notice.params.nested as Record<string, unknown>).safe).toBe("ok");
  });

  it("produces backtrace frames", () => {
    const notice = buildNotice(new Error("x"), config);
    expect(Array.isArray(notice.errors[0]?.backtrace)).toBe(true);
    expect(notice.errors[0]!.backtrace.length).toBeGreaterThan(0);
    const top = notice.errors[0]!.backtrace[0]!;
    expect(top.index).toBe(0);
  });

  it("includes project_id when set", () => {
    const notice = buildNotice(new Error("x"), config);
    expect(notice.project_id).toBe("p_1");
  });
});
