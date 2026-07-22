import { describe, expect, it } from "vitest";
import { shouldDismissFeedSwipe, shouldOpenTaskSwipe } from "./SwipeToTask";

describe("task swipe gesture", () => {
  it("opens after a deliberate right swipe and dismisses after a deliberate left swipe", () => {
    expect(shouldOpenTaskSwipe(96, 12)).toBe(true);
    expect(shouldDismissFeedSwipe(-96, 12)).toBe(true);
  });

  it("does not turn vertical Feed scrolling or short movement into navigation", () => {
    expect(shouldOpenTaskSwipe(96, 100)).toBe(false);
    expect(shouldOpenTaskSwipe(40, 2)).toBe(false);
    expect(shouldOpenTaskSwipe(-96, 2)).toBe(false);
    expect(shouldDismissFeedSwipe(-96, 100)).toBe(false);
  });
});
