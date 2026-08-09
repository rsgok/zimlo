import { describe, expect, it } from "vitest";
import { ClientCommandSchema, PushRouteV1Schema } from "../src/index.js";

describe("task.command.cancel", () => {
  it("accepts exactly one locator", () => {
    expect(ClientCommandSchema.safeParse({ type: "task.command.cancel", commandId: "cmd-1" }).success).toBe(true);
    expect(ClientCommandSchema.safeParse({ type: "task.command.cancel", idempotencyKey: "k-1" }).success).toBe(true);
  });

  it("rejects both or neither locator", () => {
    expect(ClientCommandSchema.safeParse({ type: "task.command.cancel", commandId: "cmd-1", idempotencyKey: "k-1" }).success).toBe(false);
    expect(ClientCommandSchema.safeParse({ type: "task.command.cancel" }).success).toBe(false);
  });
});

describe("feed.dismiss.set", () => {
  it("parses an explicit dismiss toggle with an idempotency key", () => {
    const parsed = ClientCommandSchema.safeParse({ type: "feed.dismiss.set", itemId: "post:p-1", dismissed: true, idempotencyKey: "k-1" });
    expect(parsed.success).toBe(true);
  });

  it("requires the dismiss flag and idempotency key", () => {
    expect(ClientCommandSchema.safeParse({ type: "feed.dismiss.set", itemId: "post:p-1", idempotencyKey: "k-1" }).success).toBe(false);
    expect(ClientCommandSchema.safeParse({ type: "feed.dismiss.set", itemId: "post:p-1", dismissed: false }).success).toBe(false);
  });

  it("keeps the legacy feed.dismiss command working", () => {
    expect(ClientCommandSchema.safeParse({ type: "feed.dismiss", itemId: "post:p-1" }).success).toBe(true);
  });
});

describe("task.pin / task.archive idempotency keys", () => {
  it("stay optional for existing clients", () => {
    expect(ClientCommandSchema.safeParse({ type: "task.pin", sessionId: "s-1", pinned: true }).success).toBe(true);
    expect(ClientCommandSchema.safeParse({ type: "task.archive", sessionId: "s-1", archived: false }).success).toBe(true);
  });

  it("accept an idempotency key when provided", () => {
    expect(ClientCommandSchema.safeParse({ type: "task.pin", sessionId: "s-1", pinned: true, idempotencyKey: "k-1" }).success).toBe(true);
    expect(ClientCommandSchema.safeParse({ type: "task.archive", sessionId: "s-1", archived: true, idempotencyKey: "k-2" }).success).toBe(true);
  });
});

describe("agent.profile.update idempotency key", () => {
  const command = {
    type: "agent.profile.update",
    projectId: "project-1",
    displayName: "Zimlo",
    avatar: "agent-1",
    bio: "Mobile agent",
    defaultProvider: "codex",
  } as const;

  it("accepts correlated updates from new clients", () => {
    expect(ClientCommandSchema.safeParse({ ...command, idempotencyKey: "profile-1" }).success).toBe(true);
  });

  it("keeps updates from existing clients compatible", () => {
    expect(ClientCommandSchema.safeParse(command).success).toBe(true);
  });
});

describe("push route v1", () => {
  it("parses the minimal and the full route", () => {
    expect(PushRouteV1Schema.safeParse({ version: 1, sessionId: "s-1" }).success).toBe(true);
    expect(PushRouteV1Schema.safeParse({
      version: 1,
      sessionId: "s-1",
      taskTitle: "修复登录回归",
      actionId: "a-1",
      decision: "allow-once",
      expiresAt: "2026-07-20T12:00:00.000Z",
      category: "write",
    }).success).toBe(true);
  });

  it("rejects other versions and unknown categories", () => {
    expect(PushRouteV1Schema.safeParse({ version: 2, sessionId: "s-1" }).success).toBe(false);
    expect(PushRouteV1Schema.safeParse({ version: 1, sessionId: "s-1", category: "everything" }).success).toBe(false);
    expect(PushRouteV1Schema.safeParse({ sessionId: "s-1" }).success).toBe(false);
  });
});
