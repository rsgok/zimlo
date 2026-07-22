import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Project } from "@zimlo/protocol";
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
    expect(markup).toContain("股票研究");
    expect(markup).toContain("跟踪公司、财报和投资论文");
    expect(markup).toContain("stocks · 4 个任务");
    expect(markup).toContain("Codex");
  });
});
