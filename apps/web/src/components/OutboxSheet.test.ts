import { describe, expect, it } from "vitest";
import type { ClientCommand } from "@zimlo/protocol";
import { describeOutboxCommand } from "./OutboxSheet";

describe("describeOutboxCommand", () => {
  it("describes task creation with the workspace label and text preview", () => {
    const command: ClientCommand = { type: "task.create", provider: "codex", workspaceId: "ws-1", text: "修复登录回归", idempotencyKey: "k-1" };
    expect(describeOutboxCommand(command, [], [])).toEqual({ typeLabel: "新任务", target: "可信目录", preview: "修复登录回归" });
  });

  it("resolves the session title for follow-ups and falls back to a shortened id", () => {
    const command: ClientCommand = { type: "task.follow_up", sessionId: "session-abcdef", text: "继续", idempotencyKey: "k-2" };
    expect(describeOutboxCommand(command, [], []).target).toBe("任务 session-…");
  });

  it("distinguishes dismiss from restore for feed.dismiss.set", () => {
    const dismiss: ClientCommand = { type: "feed.dismiss.set", itemId: "post:p-1", dismissed: true, idempotencyKey: "k-3" };
    const restore: ClientCommand = { type: "feed.dismiss.set", itemId: "post:p-1", dismissed: false, idempotencyKey: "k-4" };
    expect(describeOutboxCommand(dismiss, [], []).typeLabel).toBe("移出 Feed");
    expect(describeOutboxCommand(restore, [], []).typeLabel).toBe("恢复 Feed 卡片");
  });

  it("describes a persisted cancellation intent", () => {
    const command: ClientCommand = { type: "task.command.cancel", idempotencyKey: "target-command-key" };
    expect(describeOutboxCommand(command, [], [])).toEqual({
      typeLabel: "撤回指令",
      target: null,
      preview: "指令 target-c…",
    });
  });
});
