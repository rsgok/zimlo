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

  it("uses explicit actions in the desktop interaction mode", () => {
    const markup = renderToStaticMarkup(createElement(SwipeToTask, {
      sessionId: "session-a",
      mode: "desktop",
      onOpen: () => undefined,
      onDismiss: () => undefined,
      children: createElement("article", null, "卡片内容"),
    }));

    expect(markup).toContain("desktop-feed-item");
    expect(markup).toContain("查看任务");
    expect(markup).toContain("移出 Feed");
    expect(markup).not.toContain("左滑查看");
    expect(markup).not.toContain("swipe-task-reveal");
  });
});
