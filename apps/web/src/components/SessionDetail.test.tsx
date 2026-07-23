import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_CAPABILITIES, type FeedPost, type Session, type TaskCommand, type UnifiedEvent } from "@zimlo/protocol";
import { buildTaskTimeline, conciseInstruction, SessionDetail } from "./SessionDetail";

const session: Session = {
  id: "session-a",
  provider: "claude",
  surface: "cli",
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
  {
    id: "diff-event",
    sequence: 3,
    provider: "claude",
    sessionId: session.id,
    providerSessionId: session.providerSessionId,
    kind: "files_changed",
    source: "app_server",
    occurredAt: "2026-07-22T09:20:00.000Z",
    payload: { summary: "更新 Feed", diff: "- old\n+ new" },
    provenance: "verified",
  },
];

const command: TaskCommand = {
  id: "command-a",
  idempotencyKey: "device-a:command-a",
  kind: "follow_up",
  provider: "claude",
  sessionId: session.id,
  workspaceId: null,
  cwd: session.cwd!,
  text: "继续补充移动端验证",
  state: "queued",
  createdAt: "2026-07-22T09:30:00.000Z",
  updatedAt: "2026-07-22T09:30:00.000Z",
};

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
      <SessionDetail session={session} events={events} actions={[]} posts={[post]} commands={[command]} send={vi.fn()} onClose={vi.fn()} />,
    );

    expect(markup).toContain("左滑进入当前任务详情");
    expect(markup).toContain("详情页已经重构");
    expect(markup).toContain("Claude Code");
    expect(markup).toContain("项目 · zimlo");
    expect(markup).toContain("继续补充移动端验证");
    expect(markup).toContain("查看任务 Diff");
    expect(markup).toContain("- old");
    expect(markup.match(/data-timeline-level="primary"/g)).toHaveLength(3);
    expect(markup.match(/data-timeline-level="secondary"/g)).toHaveLength(1);
    expect(markup).not.toContain("SECRET_TOOL_COMMAND");
    expect(markup).not.toContain("command started");
  });

  it("groups one provider turn into a single primary item with second-level execution details", () => {
    const turnEvents = events.map((event) => ({ ...event, turnId: "turn-a" }));
    const matchingCommand = { ...command, text: "左滑进入当前任务详情" };
    const timeline = buildTaskTimeline([], [matchingCommand], turnEvents);

    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.type).toBe("command");
    expect(timeline[0]?.details.map((event) => event.id)).toEqual(["diff-event"]);
    expect(timeline[0]?.aliases).toContain("event:instruction");
    expect(timeline[0]?.aliases).toContain("event:diff-event");
  });

  it("removes attachment wrappers and local paths from first-level instruction copy", () => {
    const display = conciseInstruction("# Files mentioned by the user:\n\n## codex-clipboard.png: /private/tmp/codex-clipboard.png\n\n## My request for Codex:\n请优化 Timeline 的一级信息");

    expect(display).toBe("请优化 Timeline 的一级信息");
  });

  it("keeps task-attributed diffs inside the timeline", () => {
    const markup = renderToStaticMarkup(
      <SessionDetail session={session} events={events} actions={[]} posts={[post]} commands={[]} send={vi.fn()} onClose={vi.fn()} />,
    );

    expect(markup).toContain("查看任务 Diff");
    expect(markup).toContain("- old");
    expect(markup).toContain("+ new");
    expect(markup).not.toContain("SECRET_TOOL_COMMAND");
  });

  it("hides a raw completion message when an Agent result already covers it", () => {
    const completed: UnifiedEvent = {
      id: "completed", sequence: 4, provider: "claude", sessionId: session.id, providerSessionId: session.providerSessionId,
      kind: "completed", source: "hook", occurredAt: "2026-07-22T10:01:00.000Z",
      payload: { message: "RAW_DUPLICATE_COMPLETION" }, provenance: "verified",
    };
    const markup = renderToStaticMarkup(
      <SessionDetail session={session} events={[...events, completed]} actions={[]} posts={[post]} commands={[]} send={vi.fn()} onClose={vi.fn()} />,
    );
    expect(markup).toContain("详情页已经重构");
    expect(markup).not.toContain("RAW_DUPLICATE_COMPLETION");
  });

  it("falls back to the session title when a discovered task has no instruction event", () => {
    const markup = renderToStaticMarkup(
      <SessionDetail session={session} events={[]} actions={[]} posts={[]} commands={[]} send={vi.fn()} onClose={vi.fn()} />,
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
        commands={[]}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(markup).toContain("继续当前任务");
    expect(markup).toContain("加入队列");
  });
});
