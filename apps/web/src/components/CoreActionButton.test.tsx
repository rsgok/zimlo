import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CoreActionButton, coreActionState } from "./CoreActionButton";

const base = {
  connected: true,
  composerOpen: false,
  pendingActionCount: 0,
  failedOutboxCount: 0,
  pendingOutboxCount: 0,
  taskStates: [] as string[],
  commandStates: [] as string[],
};

describe("CoreActionButton", () => {
  it("uses the same state priority as the iOS core action", () => {
    expect(coreActionState(base)).toBe("idle");
    expect(coreActionState({ ...base, taskStates: ["running"] })).toBe("active");
    expect(coreActionState({ ...base, taskStates: ["running", "user_review"] })).toBe("attention");
    expect(coreActionState({ ...base, connected: false, taskStates: ["user_review"] })).toBe("offline");
    expect(coreActionState({ ...base, connected: false, composerOpen: true })).toBe("composing");
  });

  it("renders an accessible orbit node without the old conversation icon", () => {
    const markup = renderToStaticMarkup(<CoreActionButton state="active" onClick={vi.fn()} />);
    expect(markup).toContain('aria-label="新任务"');
    expect(markup).toContain('aria-valuetext="Agent 正在工作"');
    expect(markup).toContain("core-action-arc");
    expect(markup).not.toContain("bottom-nav-create");
  });
});
