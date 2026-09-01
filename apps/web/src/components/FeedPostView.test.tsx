import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_CAPABILITIES, type FeedPost, type Material, type Session } from "@zimlo/protocol";
import { FeedPostView } from "./FeedPostView";

const session: Session = {
  id: "session-a", provider: "codex", surface: "gui", providerSessionId: "run-a", title: "等待产品决定",
  cwd: "/Users/kai/Code/zimlo", transcriptPath: null, status: "waiting", lastActivityAt: "2026-07-23T00:00:00.000Z",
  createdAt: "2026-07-23T00:00:00.000Z", activePid: null, processStartedAt: null, tty: null,
  correlationUncertain: false, capabilities: EMPTY_CAPABILITIES,
};

const post: FeedPost = {
  id: "post-a", taskId: "task-a", runId: "run-a", agentId: "codex", sessionId: session.id,
  kind: "attention",
  presentation: { system: "swiss", theme: "safety_orange", layout: "alert", typography: "sans", density: "balanced", mediaPlacement: "none" },
  headline: "需要确认交互方向", takeaway: "Agent 正在等待回答。",
  highlights: [], blocks: [], dedupeKey: "attention-a", source: "agent", createdAt: "2026-07-23T00:00:00.000Z",
};

const renderPost = (value: FeedPost, materials: Material[] = [], interactionMode: "swipe" | "desktop" = "swipe", historical = false) => renderToStaticMarkup(
  <FeedPostView post={value} materials={materials} session={session} project={undefined} onOpenProject={vi.fn()} interactionMode={interactionMode} historical={historical} />,
);

describe("FeedPostView", () => {
  it("keeps editorial cards free of review and inline reply controls", () => {
    const markup = renderPost(post);
    expect(markup).toContain("需要确认交互方向");
    expect(markup).not.toContain("直接回复 Agent");
    expect(markup).not.toContain(">接受</button>");
    expect(markup).not.toContain("需要你处理");
    expect(markup).not.toContain("post-position");
  });

  it("uses a desktop task hint without exposing runtime or directory metadata", () => {
    const markup = renderPost({ ...post, kind: "result" }, [], "desktop");
    expect(markup).toContain("打开任务");
    expect(markup).not.toContain("左滑");
    expect(markup).not.toContain("/Users/kai");
    expect(markup).not.toContain("Codex");
  });

  it("keeps the history state in the footer instead of overlaying the timestamp", () => {
    const markup = renderPost(post, [], "desktop", true);
    expect(markup).toContain('post-task-hint">历史');
    expect(markup).not.toContain("history-label");
    expect(markup).not.toContain("打开任务");
  });

  it("plays video in place and reads long text inside the card", () => {
    const base: Material = {
      id: "material_0123456789abcdef", kind: "pdf", name: "brief.pdf", mimeType: "application/pdf",
      sizeBytes: 12_000, sha256: "a".repeat(64), origin: "agent", status: "ready", createdAt: "2026-08-01T00:00:00.000Z",
    };
    const video: Material = { ...base, id: "material_abcdef0123456789", kind: "video", name: "demo.mp4", mimeType: "video/mp4", durationMs: 6_000 };
    const markdown: Material = { ...base, id: "material_feedface012345", kind: "document", name: "notes.md", mimeType: "text/markdown" };
    const markdownMarkup = renderPost({ ...post, content: { type: "document", materialId: markdown.id } }, [markdown]);
    const videoMarkup = renderPost({ ...post, content: { type: "video", materialId: video.id } }, [video]);
    expect(markdownMarkup).toContain("feed-document-reader-scroll");
    expect(videoMarkup).toContain("<video");
    expect(videoMarkup).toContain("loop=\"\"");
    expect(videoMarkup).not.toContain("feed-media-viewer");
  });

  it("renders PDF inline and keeps only a weak full-screen reader action", () => {
    const pdf: Material = {
      id: "material_0123456789abcdef", kind: "pdf", name: "brief.pdf", mimeType: "application/pdf",
      sizeBytes: 12_000, sha256: "a".repeat(64), origin: "agent", status: "ready", createdAt: "2026-08-01T00:00:00.000Z",
    };
    const markup = renderPost({ ...post, content: { type: "document", materialId: pdf.id } }, [pdf]);
    expect(markup).toContain("feed-pdf-reader");
    expect(markup).toContain("<iframe");
    expect(markup).toContain("全屏阅读");
  });
});
