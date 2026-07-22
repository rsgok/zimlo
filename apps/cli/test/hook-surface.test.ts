import { describe, expect, it } from "vitest";
import { surfaceFromProcessChain } from "../src/hook-surface.js";

describe("hook surface detection", () => {
  it("prefers a real terminal and recognizes the Claude desktop process chain", () => {
    expect(surfaceFromProcessChain([
      { pid: 2, ppid: 1, tty: "ttys003", command: "claude" },
    ])).toBe("cli");
    expect(surfaceFromProcessChain([
      { pid: 2, ppid: 1, tty: "??", command: "/Applications/Claude Code.app/Contents/MacOS/Claude Code" },
    ])).toBe("gui");
    expect(surfaceFromProcessChain([
      { pid: 2, ppid: 1, tty: "??", command: "claude -p task" },
    ])).toBe("unknown");
  });
});
