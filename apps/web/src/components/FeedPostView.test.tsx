import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_CAPABILITIES, type FeedPost, type Session } from "@zimlo/protocol";
import { FeedPostView } from "./FeedPostView";

const session: Session = {
  id: "session-a", provider: "codex", surface: "gui", providerSessionId: "run-a", title: "等待产品决定",
  cwd: "/Users/kai/Code/zimlo", transcriptPath: null, status: "waiting", lastActivityAt: "2026-07-23T00:00:00.000Z",
  createdAt: "2026-07-23T00:00:00.000Z", activePid: null, processStartedAt: null, tty: null,
  correlationUncertain: false, capabilities: EMPTY_CAPABILITIES,
};

const post: FeedPost = {
  id: "post-a", taskId: "task-a", runId: "run-a", agentId: "codex", sessionId: session.id,
  kind: "attention", template: "marker", headline: "需要确认交互方向", takeaway: "Agent 正在等待回答。",
  highlights: [], actionRequired: true, actionPrompt: "是否采用方案 A？", actions: ["reply"], pendingActionIds: [],
  dedupeKey: "attention-a", source: "agent", createdAt: "2026-07-23T00:00:00.000Z",
};

describe("FeedPostView", () => {
  it("offers a voice-first inline reply for direct attention posts", () => {
    const markup = renderToStaticMarkup(
      <FeedPostView post={post} session={session} project={undefined} actions={[]} needsAction send={vi.fn()} onOpenProject={vi.fn()} position={1} total={1} />,
    );
    expect(markup).toContain("是否采用方案 A？");
    expect(markup).toContain("直接回复 Agent");
    expect(markup).toContain("说出或输入回复");
    expect(markup).toContain("需要你处理");
  });

  it("uses a desktop instruction instead of a swipe instruction in the macOS shell", () => {
    const resultPost = { ...post, kind: "result" as const, actionRequired: false, actionPrompt: undefined, actions: [], pendingActionIds: [] };
    const markup = renderToStaticMarkup(
      <FeedPostView post={resultPost} session={session} project={undefined} actions={[]} needsAction={false} send={vi.fn()} onOpenProject={vi.fn()} position={1} total={1} interactionMode="desktop" />,
    );

    expect(markup).toContain("打开任务查看完整结果");
    expect(markup).not.toContain("左滑");
  });
});
