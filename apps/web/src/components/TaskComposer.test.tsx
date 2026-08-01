import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_CAPABILITIES, type Project, type Session, type TrustedWorkspace } from "@zimlo/protocol";
import { defaultWorkspaceId, TaskComposer } from "./TaskComposer";

const workspaces: TrustedWorkspace[] = [
  { id: "older", label: "older", path: "/Projects/older", providers: ["codex"], lastUsedAt: "2026-07-20T00:00:00.000Z" },
  { id: "zimlo", label: "zimlo", path: "/Projects/zimlo", providers: ["codex", "claude"], lastUsedAt: "2026-07-24T00:00:00.000Z" },
];

const project: Project = {
  id: "project-zimlo",
  name: "zimlo",
  primaryPath: "/Projects/zimlo",
  paths: ["/Projects/zimlo"],
  providers: ["codex", "claude"],
  sessionCount: 4,
  postCount: 8,
  agentProfile: {
    displayName: "Zimlo",
    avatar: "user-07",
    bio: "负责 Zimlo 项目",
    defaultProvider: "claude",
    updatedAt: "2026-07-24T00:00:00.000Z",
  },
  createdAt: "2026-07-20T00:00:00.000Z",
  lastUsedAt: "2026-07-24T00:00:00.000Z",
};

const session: Session = {
  id: "session-zimlo", provider: "codex", surface: "gui", providerSessionId: "run-zimlo",
  title: "沉浸式 Feed", projectName: "zimlo", cwd: "/Projects/zimlo", transcriptPath: null,
  status: "running", lastActivityAt: "2026-07-24T00:00:00.000Z", createdAt: "2026-07-24T00:00:00.000Z",
  activePid: null, processStartedAt: null, tty: null, correlationUncertain: false, capabilities: EMPTY_CAPABILITIES,
};

describe("TaskComposer", () => {
  it("defaults to the requested, saved, then most recently used workspace", () => {
    expect(defaultWorkspaceId(workspaces, "older", "zimlo")).toBe("older");
    expect(defaultWorkspaceId(workspaces, undefined, "older")).toBe("older");
    expect(defaultWorkspaceId(workspaces)).toBe("zimlo");
  });

  it("leads with the task goal and keeps technical routing behind the Agent chooser", () => {
    const markup = renderToStaticMarkup(
      <TaskComposer
        workspaces={workspaces}
        projects={[project]}
        initialProjectId={project.id}
        send={vi.fn(() => true)}
        onClose={vi.fn()}
      />,
    );

    expect(markup).toContain("<h2 id=\"new-task-title\">新任务</h2>");
    expect(markup).toContain("任务内容");
    expect(markup).toContain("草稿自动保存");
    expect(markup).toContain("交给谁");
    expect(markup).toContain("Zimlo");
    expect(markup).toContain("/avatars/user-07.png");
    expect(markup).toContain("aria-label=\"添加附件\"");
    expect(markup).toContain("aria-label=\"开始任务\"");
    expect(markup).toContain("aria-label=\"开始语音输入\"");
    expect(markup).not.toContain("autofocus");
    expect(markup).not.toContain("NEW TASK");
    expect(markup).not.toContain("Project Agent");
    expect(markup).not.toContain("/Projects/zimlo");
    expect(markup.indexOf("任务内容")).toBeLessThan(markup.indexOf("交给谁"));
  });

  it("renders an unmistakable compact reply composer for an existing session", () => {
    const markup = renderToStaticMarkup(
      <TaskComposer
        workspaces={workspaces}
        projects={[project]}
        session={session}
        send={vi.fn(() => true)}
        onClose={vi.fn()}
      />,
    );

    expect(markup).toContain("new-task-sheet is-follow-up");
    expect(markup).toContain("回复当前会话");
    expect(markup).toContain(session.title);
    expect(markup).not.toContain("交给谁");
    expect(markup).not.toContain("新任务");
    expect(markup).toContain('aria-label="发送消息"');
    expect(markup).not.toContain("autofocus");
  });
});
