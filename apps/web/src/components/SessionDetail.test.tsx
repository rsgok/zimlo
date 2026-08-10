import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_CAPABILITIES, type FeedPost, type Project, type Session, type TaskCommand, type TaskRecord, type UnifiedEvent } from "@zimlo/protocol";
import { buildTaskTimeline, conciseInstruction, SessionDetail, taskNavigationTitle, taskOriginalInput } from "./SessionDetail";

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
  dedupeKey: "result-a",
  source: "agent",
  createdAt: "2026-07-22T10:00:00.000Z",
};

const project: Project = {
  id: "project-zimlo",
  name: "zimlo",
  primaryPath: "/Users/kai/Code/zimlo",
  paths: ["/Users/kai/Code/zimlo"],
  providers: ["claude"],
  sessionCount: 1,
  postCount: 1,
  agentProfile: {
    displayName: "Zimlo Agent",
    avatar: "🪄",
    bio: "负责 Zimlo 项目",
    defaultProvider: "claude",
    updatedAt: "2026-07-24T00:00:00.000Z",
  },
  createdAt: "2026-07-22T09:00:00.000Z",
  lastUsedAt: "2026-07-24T00:00:00.000Z",
};

describe("SessionDetail", () => {
  it("shows task input and curated timeline without tool events", () => {
    const markup = renderToStaticMarkup(
      <SessionDetail session={session} events={events} actions={[]} posts={[post]} commands={[command]} userAvatarId="user-01" send={vi.fn()} onClose={vi.fn()} />,
    );

    expect(markup).toContain("左滑进入当前任务详情");
    expect(markup).toContain("详情页已经重构");
    expect(markup).toContain("现在只保留需要阅读的更新。");
    expect(markup).toContain("Claude Code");
    expect(markup).toContain("项目 · zimlo");
    expect(markup).toContain("继续补充移动端验证");
    expect(markup).toContain("查看任务 Diff");
    expect(markup).toContain("- old");
    expect(markup.match(/data-timeline-level="primary"/g)).toHaveLength(3);
    expect(markup.match(/data-timeline-level="secondary"/g)).toHaveLength(1);
    expect(markup).not.toContain("SECRET_TOOL_COMMAND");
    expect(markup).not.toContain("command started");
    expect(markup).not.toContain("现在需要你");
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
      <SessionDetail session={session} events={events} actions={[]} posts={[post]} commands={[]} userAvatarId="user-01" send={vi.fn()} onClose={vi.fn()} />,
    );

    expect(markup).toContain("查看任务 Diff");
    expect(markup).toContain("- old");
    expect(markup).toContain("+ new");
    expect(markup).not.toContain("SECRET_TOOL_COMMAND");
  });

  it("uses the saved Project Agent avatar for each agent Timeline item", () => {
    const markup = renderToStaticMarkup(
      <SessionDetail session={{ ...session, projectId: project.id }} project={project} events={events} actions={[]} posts={[post]} commands={[]} userAvatarId="user-24" send={vi.fn()} onClose={vi.fn()} />,
    );

    expect(markup).toContain("🪄");
    expect(markup).toContain('/avatars/user-24.png');
  });

  it("hides a raw completion message when an Agent result already covers it", () => {
    const completed: UnifiedEvent = {
      id: "completed", sequence: 4, provider: "claude", sessionId: session.id, providerSessionId: session.providerSessionId,
      kind: "completed", source: "hook", occurredAt: "2026-07-22T10:01:00.000Z",
      payload: { message: "RAW_DUPLICATE_COMPLETION" }, provenance: "verified",
    };
    const markup = renderToStaticMarkup(
      <SessionDetail session={session} events={[...events, completed]} actions={[]} posts={[post]} commands={[]} userAvatarId="user-01" send={vi.fn()} onClose={vi.fn()} />,
    );
    expect(markup).toContain("详情页已经重构");
    expect(markup).not.toContain("RAW_DUPLICATE_COMPLETION");
  });

  it("falls back to the session title when a discovered task has no instruction event", () => {
    const markup = renderToStaticMarkup(
      <SessionDetail session={session} events={[]} actions={[]} posts={[]} commands={[]} userAvatarId="user-01" send={vi.fn()} onClose={vi.fn()} />,
    );

    expect(markup).toContain("修复 Feed 交互");
    expect(markup).toContain("还没有需要阅读的更新");
  });

  it("shows the full task input while keeping concise page semantics", () => {
    const longInput = `${"请完整保留任务输入。".repeat(30)}结尾验收词`;
    const longInstruction = { ...events[0]!, payload: { prompt: longInput } };
    const markup = renderToStaticMarkup(
      <SessionDetail session={session} events={[longInstruction]} actions={[]} posts={[]} commands={[]} userAvatarId="user-01" send={vi.fn()} onClose={vi.fn()} />,
    );

    expect(markup).toContain('class="task-profile-header" aria-label="修复 Feed 交互"');
    expect(markup).not.toContain("app-top-bar");
    expect(markup).toContain("结尾验收词");
    expect(markup).not.toContain("查看完整输入");
  });

  it("uses authored task titles but falls back to a concise original input", () => {
    expect(taskNavigationTitle("修复 Feed 交互", "一段不同的完整任务输入")).toBe("修复 Feed 交互");
    expect(taskNavigationTitle("Codex · 019fb818", "请重构任务详情，保留最新结论和下一步")).toBe("请重构任务详情");
  });

  it("does not mistake a late follow-up for the original task when the opening event is missing", () => {
    const lateFollowUp = { ...events[0]!, occurredAt: "2026-07-22T09:30:00.000Z", payload: { prompt: "push all" } };
    expect(taskOriginalInput(session, [lateFollowUp])).toBe("修复 Feed 交互");
    expect(taskOriginalInput(session, [events[0]!])).toBe("左滑进入当前任务详情");
  });

  it("only shows a human next action when review is actually required", () => {
    const reviewTask: TaskRecord = {
      id: "task-review",
      runId: session.providerSessionId,
      agentId: "claude",
      sessionId: session.id,
      state: "user_review",
      reason: "结果等待审阅",
      updatedAt: "2026-07-22T10:00:00.000Z",
    };
    const markup = renderToStaticMarkup(
      <SessionDetail session={session} task={reviewTask} events={events} actions={[]} posts={[post]} commands={[]} userAvatarId="user-01" send={vi.fn()} onClose={vi.fn()} />,
    );

    expect(markup).toContain("现在需要你");
    expect(markup).toContain("审阅最新结论");
    expect(markup).not.toContain("有需要时继续对话");
  });

  it("does not duplicate the global conversation composer in task detail", () => {
    const markup = renderToStaticMarkup(
      <SessionDetail
        session={{ ...session, capabilities: { ...session.capabilities, replyable: true, resumable: true } }}
        events={events}
        actions={[]}
        posts={[]}
        commands={[]}
        userAvatarId="user-01"
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(markup).not.toContain("继续当前任务");
    expect(markup).not.toContain("加入队列");
  });
});
