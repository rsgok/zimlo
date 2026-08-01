import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_CAPABILITIES, type FeedPost, type Material, type Session, type TaskReview } from "@zimlo/protocol";
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

  it("keeps video in the feed and uses an in-app reader for long text", () => {
    const document: Material = {
      id: "material_0123456789abcdef", kind: "pdf", name: "brief.pdf", mimeType: "application/pdf",
      sizeBytes: 12_000, sha256: "a".repeat(64), origin: "agent", status: "ready", createdAt: "2026-08-01T00:00:00.000Z",
    };
    const video: Material = {
      ...document, id: "material_abcdef0123456789", kind: "video", name: "demo.mp4", mimeType: "video/mp4", durationMs: 6_000,
    };
    const markdown: Material = {
      ...document, id: "material_feedface012345", kind: "document", name: "notes.md", mimeType: "text/markdown",
    };
    const markdownMarkup = renderToStaticMarkup(<FeedPostView
      post={{ ...post, content: { type: "document", materialId: markdown.id } }} materials={[markdown]}
      session={session} project={undefined} actions={[]} needsAction={false} send={vi.fn()} onOpenProject={vi.fn()} position={1} total={1}
    />);
    const videoMarkup = renderToStaticMarkup(<FeedPostView
      post={{ ...post, content: { type: "video", materialId: video.id } }} materials={[video]}
      session={session} project={undefined} actions={[]} needsAction={false} send={vi.fn()} onOpenProject={vi.fn()} position={1} total={1}
    />);

    expect(markdownMarkup).toContain("feed-document-reader-scroll");
    expect(markdownMarkup).toContain("正在读取");
    expect(videoMarkup).toContain("<video");
    expect(videoMarkup).toContain("loop=\"\"");
    expect(videoMarkup).toContain("播放视频：demo.mp4");
    expect(videoMarkup).not.toContain("feed-media-viewer");
  });

  it("keeps PDF as an explicit document preview", () => {
    const pdf: Material = {
      id: "material_0123456789abcdef", kind: "pdf", name: "brief.pdf", mimeType: "application/pdf",
      sizeBytes: 12_000, sha256: "a".repeat(64), origin: "agent", status: "ready", createdAt: "2026-08-01T00:00:00.000Z",
    };
    const markup = renderToStaticMarkup(<FeedPostView
      post={{ ...post, content: { type: "document", materialId: pdf.id } }} materials={[pdf]}
      session={session} project={undefined} actions={[]} needsAction={false} send={vi.fn()} onOpenProject={vi.fn()} position={1} total={1}
    />);

    expect(markup).toContain("<button type=\"button\" class=\"feed-document\"");
    expect(markup).not.toContain("target=\"_blank\"");
  });

  it("keeps result review actions compact and plainly named", () => {
    const review = { id: "review-a", state: "unreviewed" } as TaskReview;
    const markup = renderToStaticMarkup(<FeedPostView
      post={post} session={session} project={undefined} actions={[]} review={review}
      needsAction send={vi.fn()} onOpenProject={vi.fn()} position={1} total={1}
    />);

    expect(markup).toContain(">接受</button>");
    expect(markup).toContain("<summary>修改</summary>");
    expect(markup).not.toContain("接受结果");
    expect(markup).not.toContain("要求修改");
  });
});
