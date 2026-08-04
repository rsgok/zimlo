import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SwipeToTask, shouldDismissFeedSwipe, shouldOpenTaskSwipe } from "./SwipeToTask";

describe("task swipe gesture", () => {
  it("opens after a deliberate left swipe and dismisses after a deliberate right swipe", () => {
    expect(shouldOpenTaskSwipe(-96, 12)).toBe(true);
    expect(shouldDismissFeedSwipe(96, 12)).toBe(true);
  });

  it("does not turn vertical Feed scrolling or short movement into navigation", () => {
    expect(shouldOpenTaskSwipe(-96, 100)).toBe(false);
    expect(shouldOpenTaskSwipe(-40, 2)).toBe(false);
    expect(shouldOpenTaskSwipe(96, 2)).toBe(false);
    expect(shouldDismissFeedSwipe(96, 100)).toBe(false);
    expect(shouldDismissFeedSwipe(-96, 2)).toBe(false);
  });

  it("uses quiet directional icon actions in the desktop interaction mode", () => {
    const markup = renderToStaticMarkup(createElement(SwipeToTask, {
      sessionId: "session-a",
      mode: "desktop",
      onOpen: () => undefined,
      onDismiss: () => undefined,
      children: createElement("article", null, "卡片内容"),
    }));

    expect(markup).toContain("desktop-feed-item");
    expect(markup).toContain("desktop-feed-action-dismiss");
    expect(markup).toContain("desktop-feed-action-profile");
    expect(markup).toContain('aria-label="移出 Feed"');
    expect(markup).toContain('aria-label="查看任务"');
    expect(markup).toMatch(/desktop-feed-action-dismiss[^]*?<path d="M19 12H5/);
    expect(markup).toMatch(/desktop-feed-action-profile[^]*?<path d="M5 12h14/);
    expect(markup).not.toContain(">查看任务<");
    expect(markup).not.toContain(">移出 Feed<");
    expect(markup).not.toContain("swipe-task-reveal");
  });
});
