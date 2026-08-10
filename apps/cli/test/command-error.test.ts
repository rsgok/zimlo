import { describe, expect, it } from "vitest";
import { commandError } from "../src/command-error.js";

describe("commandError", () => {
  it("correlates a durable rejection with the originating outbox entry", () => {
    expect(commandError({
      type: "trust.policy.update",
      projectId: "project-missing",
      preset: "safe_automation",
      idempotencyKey: "policy-1",
    }, "project_not_found", "这个 Project 已不存在。")).toEqual({
      type: "error",
      code: "project_not_found",
      message: "这个 Project 已不存在。",
      commandType: "trust.policy.update",
      idempotencyKey: "policy-1",
    });
  });

  it("keeps non-durable legacy commands valid without inventing a key", () => {
    expect(commandError({ type: "devices.request" }, "forbidden", "无权访问")).toEqual({
      type: "error",
      code: "forbidden",
      message: "无权访问",
      commandType: "devices.request",
    });
  });
});
