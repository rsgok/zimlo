import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_CAPABILITIES, type Project, type Session } from "@zimlo/protocol";
import { AgentsView } from "./AgentsView";

const project: Project = {
  id: "project:agent",
  name: "stocks",
  primaryPath: "/Projects/stocks",
  paths: ["/Projects/stocks"],
  providers: ["codex"],
  sessionCount: 4,
  postCount: 8,
  agentProfile: { displayName: "股票研究", avatar: "📈", bio: "跟踪公司、财报和投资论文", defaultProvider: "codex", updatedAt: "2026-07-23T00:00:00.000Z" },
  createdAt: "2026-07-23T00:00:00.000Z",
  lastUsedAt: "2026-07-23T01:00:00.000Z",
};

describe("AgentsView", () => {
  it("presents Project identity above its runtime", () => {
    const markup = renderToStaticMarkup(<AgentsView projects={[project]} sessions={[]} onOpen={vi.fn()} onNewTask={vi.fn()} />);
    expect(markup).not.toContain("<h2");
    expect(markup).not.toContain("AGENTS");
    expect(markup).not.toContain("每个 Agent 记住一个项目的上下文");
    expect(markup).toContain("股票研究");
    expect(markup).toContain("跟踪公司、财报和投资论文");
    expect(markup).toContain("<span>stocks</span>");
    expect(markup).toContain("<span>4 个任务</span>");
    expect(markup).toContain("随时可用");
    expect(markup).toContain("Codex");
  });

  it("renders preset Agent avatars from the bundled library", () => {
    const markup = renderToStaticMarkup(
      <AgentsView projects={[{ ...project, agentProfile: { ...project.agentProfile, avatar: "user-07" } }]} sessions={[]} onOpen={vi.fn()} onNewTask={vi.fn()} />,
    );

    expect(markup).toContain('/avatars/user-07.png');
  });

  it("keeps unused placeholder Agents out of the default attention surface", () => {
    const unused = {
      ...project,
      id: "project:unused",
      name: "unused",
      sessionCount: 0,
      agentProfile: { ...project.agentProfile, displayName: "unused", bio: "负责 unused 项目的长期工作与上下文。" },
    };
    const markup = renderToStaticMarkup(<AgentsView projects={[project, unused]} sessions={[]} onOpen={vi.fn()} onNewTask={vi.fn()} />);

    expect(markup).toContain("已启用 <span>1</span>");
    expect(markup).not.toContain("<strong>unused</strong>");
  });

  it("counts indistinguishable terminal processes as one active Agent task", () => {
    const processSession: Session = {
      id: "process-a",
      projectId: project.id,
      provider: "claude",
      surface: "unknown",
      providerSessionId: "process:1:now",
      title: "Claude · 活跃进程 1",
      projectName: project.name,
      cwd: project.primaryPath,
      transcriptPath: null,
      status: "running",
      lastActivityAt: "2026-07-23T02:00:00.000Z",
      createdAt: "2026-07-23T02:00:00.000Z",
      activePid: 1,
      processStartedAt: "2026-07-23T02:00:00.000Z",
      tty: null,
      correlationUncertain: true,
      capabilities: EMPTY_CAPABILITIES,
    };
    const markup = renderToStaticMarkup(
      <AgentsView projects={[project]} sessions={[processSession, { ...processSession, id: "process-b", providerSessionId: "process:2:now", activePid: 2 }]} onOpen={vi.fn()} onNewTask={vi.fn()} />,
    );

    expect(markup).toContain("工作中 <span>1</span>");
    expect(markup).toContain("1 个进行中");
    expect(markup).not.toContain("2 个进行中");
  });
});
