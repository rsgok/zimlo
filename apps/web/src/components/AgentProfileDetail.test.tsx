import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { FeedPost, Project } from "@zimlo/protocol";
import { AgentProfileDetail } from "./AgentProfileDetail";

const project: Project = {
  id: "project-zimlo",
  name: "zimlo",
  primaryPath: "/Projects/zimlo",
  paths: ["/Projects/zimlo", "/Projects/zimlo-release"],
  providers: ["codex"],
  sessionCount: 10,
  postCount: 10,
  agentProfile: {
    displayName: "Zimlo",
    avatar: "user-01",
    bio: "持续优化 Zimlo",
    defaultProvider: "codex",
    updatedAt: "2026-07-25T00:00:00.000Z",
  },
  createdAt: "2026-07-20T00:00:00.000Z",
  lastUsedAt: "2026-07-25T00:00:00.000Z",
};

function post(index: number): FeedPost {
  return {
    id: `post-${index}`,
    projectId: project.id,
    taskId: `task-${index}`,
    runId: `run-${index}`,
    agentId: "codex",
    sessionId: null,
    kind: "result",
    template: "paper",
    headline: `动态 ${index}`,
    takeaway: `第 ${index} 条动态`,
    highlights: [],
    dedupeKey: `post-${index}`,
    source: "agent",
    createdAt: `2026-07-25T${String(index).padStart(2, "0")}:00:00.000Z`,
  };
}

describe("AgentProfileDetail", () => {
  it("shows the complete primary and additional working directories", () => {
    const markup = renderToStaticMarkup(
      <AgentProfileDetail
        project={project}
        sessions={[]}
        posts={[]}
        commands={[]}
        userAvatarId="user-02"
        send={vi.fn()}
        onOpenTask={vi.fn()}
        onNewTask={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(markup).toContain("工作目录");
    expect(markup).toContain("主目录");
    expect(markup).toContain("/Projects/zimlo");
    expect(markup).toContain("其他已识别目录");
    expect(markup).toContain("/Projects/zimlo-release");
    expect(markup).toContain("正在工作");
    expect(markup).toContain("历史任务");
    expect(markup).toContain("默认 Runtime");
    expect(markup.match(/＋ 新任务/g)).toHaveLength(1);
  });

  it("keeps older Agent activity behind an explicit history action", () => {
    const markup = renderToStaticMarkup(
      <AgentProfileDetail
        project={project}
        sessions={[]}
        posts={Array.from({ length: 10 }, (_, index) => post(index))}
        commands={[]}
        userAvatarId="user-02"
        send={vi.fn()}
        onOpenTask={vi.fn()}
        onNewTask={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(markup).toContain("动态 9");
    expect(markup).toContain("动态 7");
    expect(markup).not.toContain("动态 6");
    expect(markup).toContain("查看全部 10 条动态");
  });
});
