import { describe, expect, it } from "vitest";
import type { Session } from "@zimlo/protocol";
import { conciseTaskInput, lastPathSegment, runtimeLabel, sessionLocation, sessionRuntimeLabel, surfaceLabel } from "./sessionPresentation";

const session = {
  provider: "codex",
  cwd: "/Users/kai/Code/zimlo/apps/web/",
} as Session;

describe("session presentation", () => {
  it("uses the git project when one is available", () => {
    expect(sessionLocation({ ...session, projectName: "zimlo" })).toEqual({ kind: "project", label: "zimlo" });
  });

  it("falls back to only the last cwd segment", () => {
    expect(sessionLocation(session)).toEqual({ kind: "directory", label: "web" });
    expect(lastPathSegment("C:\\work\\zimlo\\")).toBe("zimlo");
  });

  it("uses product runtime names", () => {
    expect(runtimeLabel("codex")).toBe("Codex");
    expect(runtimeLabel("claude")).toBe("Claude Code");
    expect(surfaceLabel("managed")).toBe("Zimlo 托管");
    expect(sessionRuntimeLabel({ provider: "codex", surface: "gui" })).toBe("Codex · GUI");
  });

  it("pulls the human request out of verbose annotation context", () => {
    expect(conciseTaskInput("# Diff comments:\nFile: report.pdf\nComment: 不认可重复服务一并归责于原告\n## My request for Codex:\nHandle the comment"))
      .toBe("不认可重复服务一并归责于原告");
  });
});
