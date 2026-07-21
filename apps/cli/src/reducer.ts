import { createHash } from "node:crypto";
import { redactText } from "@zimlo/adapters";
import type { FeedCard, PendingAction, UnifiedEvent } from "@zimlo/protocol";

function cardId(event: UnifiedEvent, kind: FeedCard["kind"], action?: PendingAction): string {
  const digest = createHash("sha256")
    .update(event.sessionId)
    .update("\0")
    .update(event.turnId ?? "session")
    .update("\0")
    .update(kind)
    .update("\0")
    .update(kind === "attention" ? (action?.actionId ?? event.itemId ?? event.id) : "aggregate")
    .digest("hex");
  return `card_${digest.slice(0, 24)}`;
}

function payloadRecord(event: UnifiedEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : {};
}

function textFrom(value: unknown): string {
  if (typeof value === "string") return redactText(value, 520);
  if (Array.isArray(value)) return value.map(textFrom).filter(Boolean).join(" · ");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["summary", "message", "reason", "description", "command", "path", "output", "text", "content"]) {
      if (record[key] !== undefined) {
        const result = textFrom(record[key]);
        if (result) return result;
      }
    }
  }
  return "";
}

export function reduceEventToCard(event: UnifiedEvent, action?: PendingAction): FeedCard {
  const payload = payloadRecord(event);
  let kind: FeedCard["kind"] = "progress";
  let title = "Agent 正在工作";
  let summary = textFrom(payload) || "收到新的任务进展。";
  let priority = 40;
  let status: FeedCard["status"] = "active";

  switch (event.kind) {
    case "needs_input":
      kind = "attention";
      title = "Agent 正在等待输入";
      summary = action?.detail || summary || "请回复后继续任务。";
      priority = 110;
      break;
    case "needs_approval":
      kind = "attention";
      title = "需要批准操作";
      summary = action?.detail || summary || "请检查操作内容并选择允许或拒绝。";
      priority = 120;
      break;
    case "plan_updated":
      title = "计划已更新";
      priority = 50;
      break;
    case "files_changed":
      kind = "result";
      title = "文件发生变化";
      priority = 62;
      break;
    case "command_started":
      kind = "result";
      title = "正在运行命令";
      summary = textFrom(payload.command ?? payload) || summary;
      priority = 55;
      break;
    case "command_completed":
      kind = "result";
      title = "命令执行完成";
      priority = 60;
      break;
    case "tests_passed":
      kind = "result";
      title = "测试全部通过";
      summary = textFrom(payload.command ?? payload) || "测试命令成功退出。";
      priority = 75;
      status = "resolved";
      break;
    case "tests_failed":
      kind = "failure";
      title = "测试失败";
      summary = textFrom(payload.command ?? payload) || "测试命令返回非零状态。";
      priority = 95;
      break;
    case "blocked":
      kind = "failure";
      title = "任务已阻塞";
      priority = 100;
      break;
    case "failed":
      kind = "failure";
      title = "任务失败";
      priority = 105;
      break;
    case "completed":
      kind = "completed";
      title = "任务已完成";
      priority = 85;
      status = "resolved";
      break;
    case "session_ended":
      title = "Session 已结束";
      priority = 45;
      status = "resolved";
      break;
    case "session_started":
      title = "Session 已开始";
      priority = 42;
      break;
  }

  return {
    id: cardId(event, kind, action),
    sessionId: event.sessionId,
    turnId: event.turnId ?? null,
    kind,
    title,
    summary: redactText(summary, 520),
    priority,
    status,
    actionIds: action ? [action.actionId] : [],
    updatedAt: event.occurredAt,
    provenance: event.provenance,
  };
}
