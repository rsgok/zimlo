import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_CAPABILITIES, type Session, type TaskRecord } from "@zimlo/protocol";
import { collapseProcessSessions, taskTitle, TasksView } from "./TasksView";

const session: Session = {
  id: "session-a",
  provider: "codex",
  providerSessionId: "019f8600-abcdef",
  title: "Codex · zimlo",
  projectName: "zimlo",
  cwd: "/Users/kai/Code/zimlo",
  transcriptPath: null,
  status: "running",
  lastActivityAt: "2026-07-22T10:00:00.000Z",
  createdAt: "2026-07-22T09:00:00.000Z",
  activePid: 42,
  processStartedAt: "2026-07-22T09:00:00.000Z",
  tty: null,
  correlationUncertain: false,
  capabilities: EMPTY_CAPABILITIES,
};

const task: TaskRecord = {
  id: "task-a",
  runId: session.providerSessionId,
  agentId: "codex",
  sessionId: session.id,
  state: "running",
  reason: "优化任务搜索与语义标题",
  updatedAt: "2026-07-22T10:00:00.000Z",
};

describe("TasksView", () => {
  it("uses a meaningful task reason instead of a generated runtime title", () => {
    expect(taskTitle(session, task)).toBe("优化任务搜索与语义标题");
    expect(taskTitle({ ...session, correlationUncertain: true }, task)).toBe("Codex · zimlo");
    const markup = renderToStaticMarkup(<TasksView sessions={[session]} tasks={[task]} onOpen={vi.fn()} />);
    expect(markup).toContain("优化任务搜索与语义标题");
    expect(markup).toContain("项目 · zimlo");
    expect(markup).toContain("Codex");
    expect(markup).not.toContain("/Users/kai/Code/zimlo");
  });

  it("groups indistinguishable process-only sessions from the same runtime and directory", () => {
    const processA = { ...session, id: "process-a", provider: "claude" as const, providerSessionId: "process:1:now", cwd: "/tmp/project" };
    const processB = { ...processA, id: "process-b", providerSessionId: "process:2:now" };
    const collapsed = collapseProcessSessions([processA, processB, session]);
    expect(collapsed.sessions.map((item) => item.id)).toEqual(["process-a", "session-a"]);
    expect(collapsed.counts.get("process-a")).toBe(2);
  });
});
