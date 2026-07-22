import { describe, expect, it } from "vitest";
import type { TrustedWorkspace } from "@zimlo/protocol";
import { defaultWorkspaceId } from "./TaskComposer";

const workspaces: TrustedWorkspace[] = [
  { id: "alphabetical-first", label: "A", path: "/a", providers: ["codex"], lastUsedAt: "2026-07-20T00:00:00.000Z" },
  { id: "recent", label: "Z", path: "/z", providers: ["claude"], lastUsedAt: "2026-07-23T00:00:00.000Z" },
];

describe("new task defaults", () => {
  it("prefers an explicit project, then the saved Agent, then the most recent project", () => {
    expect(defaultWorkspaceId(workspaces, "alphabetical-first", "recent")).toBe("alphabetical-first");
    expect(defaultWorkspaceId(workspaces, undefined, "alphabetical-first")).toBe("alphabetical-first");
    expect(defaultWorkspaceId(workspaces)).toBe("recent");
  });
});
