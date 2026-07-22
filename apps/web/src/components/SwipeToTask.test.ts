import { describe, expect, it } from "vitest";
import { shouldOpenTaskSwipe } from "./SwipeToTask";

describe("task swipe gesture", () => {
  it("opens after a deliberate right swipe", () => {
    expect(shouldOpenTaskSwipe(88, 12)).toBe(true);
  });

  it("does not turn vertical Feed scrolling or short movement into navigation", () => {
    expect(shouldOpenTaskSwipe(90, 100)).toBe(false);
    expect(shouldOpenTaskSwipe(40, 2)).toBe(false);
    expect(shouldOpenTaskSwipe(-90, 2)).toBe(false);
  });
});
