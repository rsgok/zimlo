import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_CAPABILITIES, type FeedPost, type Session, type UnifiedEvent } from "@zimlo/protocol";
import { SessionDetail } from "./SessionDetail";

const session: Session = {
  id: "session-a",
  provider: "claude",
  providerSessionId: "run-a",
  title: "修复 Feed 交互",
  projectName: "zimlo",
  cwd: "/Users/kai/Code/zimlo/apps/web",
  transcriptPath: null,
  status: "running",
  lastActivityAt: "2026-07-22T10:00:00.000Z",
  createdAt: "2026-07-22T09:00:00.000Z",
  activePid: null,
  processStartedAt: null,
  tty: null,
  correlationUncertain: false,
  capabilities: EMPTY_CAPABILITIES,
};

const events: UnifiedEvent[] = [
  {
    id: "instruction",
    sequence: 1,
    provider: "claude",
    sessionId: session.id,
    providerSessionId: session.providerSessionId,
    kind: "user_instruction",
    source: "hook",
    occurredAt: "2026-07-22T09:00:00.000Z",
    payload: { prompt: "左滑进入当前任务详情" },
    provenance: "verified",
  },
  {
    id: "tool-event",
    sequence: 2,
    provider: "claude",
    sessionId: session.id,
    providerSessionId: session.providerSessionId,
    kind: "command_started",
    source: "app_server",
    occurredAt: "2026-07-22T09:10:00.000Z",
    payload: { command: "SECRET_TOOL_COMMAND" },
    provenance: "verified",
  },
];

const post: FeedPost = {
  id: "post-a",
  taskId: "task-a",
  runId: session.providerSessionId,
  agentId: "claude",
  sessionId: session.id,
  kind: "result",
  template: "paper",
  headline: "详情页已经重构",
  takeaway: "现在只保留需要阅读的更新。",
  highlights: ["工具日志已隐藏"],
  proof: "Web 构建通过",
  actionRequired: false,
  actions: [],
  pendingActionIds: [],
  dedupeKey: "result-a",
  source: "agent",
  createdAt: "2026-07-22T10:00:00.000Z",
};

describe("SessionDetail", () => {
  it("shows task input and curated timeline without tool events", () => {
    const markup = renderToStaticMarkup(
      <SessionDetail session={session} events={events} actions={[]} posts={[post]} send={vi.fn()} onClose={vi.fn()} />,
    );

    expect(markup).toContain("左滑进入当前任务详情");
    expect(markup).toContain("详情页已经重构");
    expect(markup).toContain("Claude Code");
    expect(markup).toContain("项目 · zimlo");
    expect(markup).not.toContain("SECRET_TOOL_COMMAND");
    expect(markup).not.toContain("command started");
  });

  it("falls back to the session title when a discovered task has no instruction event", () => {
    const markup = renderToStaticMarkup(
      <SessionDetail session={session} events={[]} actions={[]} posts={[]} send={vi.fn()} onClose={vi.fn()} />,
    );

    expect(markup).toContain("修复 Feed 交互");
    expect(markup).toContain("还没有需要阅读的更新");
  });

  it("offers a continue action for resumable Codex and Claude tasks", () => {
    const markup = renderToStaticMarkup(
      <SessionDetail
        session={{ ...session, capabilities: { ...session.capabilities, replyable: true, resumable: true } }}
        events={events}
        actions={[]}
        posts={[]}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(markup).toContain("继续任务");
    expect(markup).toContain("可继续");
  });
});
