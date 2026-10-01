import { describe, expect, it } from "vitest";
import { surfaceFromProcessChain } from "../src/hook-surface.js";

describe("hook surface detection", () => {
  it.each([
    ["exec app-server", "cli"],
    ["exec fix app-server now", "cli"],
    ["e fix app-server", "cli"],
    ["review fix app-server", "cli"],
    ["resume session-id fix app-server", "cli"],
    ["fork session-id fix app-server", "cli"],
    ["fix app-server now", "cli"],
    ["-- app-server", "cli"],
    ["--profile app-server exec task", "cli"],
    ["--config model=example --no-daemon exec app-server", "cli"],
    ["--profile exec app-server", "gui"],
    ["--config model=example app-server --listen stdio", "gui"],
    ["--config=model=example app-server", "gui"],
  ])("uses the Codex subcommand rather than prompt tokens in %s", (args, surface) => {
    expect(surfaceFromProcessChain([
      { pid: 2, ppid: 1, tty: "??", command: `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex ${args}` },
    ])).toBe(surface);
  });

  it.each([
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
  ])("recognizes a headless CLI supplied by %s", (command) => {
    expect(surfaceFromProcessChain([
      { pid: 3, ppid: 2, tty: "??", command: `${command} exec task` },
      { pid: 2, ppid: 1, tty: "??", command: "/bin/sh automation.sh" },
    ])).toBe("cli");
    expect(surfaceFromProcessChain([
      { pid: 3, ppid: 2, tty: "??", command: `${command} app-server` },
      { pid: 2, ppid: 1, tty: "??", command: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" },
    ])).toBe("gui");
  });

  it("prefers a real terminal and recognizes desktop Agent process chains", () => {
    expect(surfaceFromProcessChain([
      { pid: 2, ppid: 1, tty: "ttys003", command: "claude" },
    ])).toBe("cli");
    expect(surfaceFromProcessChain([
      { pid: 2, ppid: 1, tty: "??", command: "/Applications/Claude Code.app/Contents/MacOS/Claude Code" },
    ])).toBe("gui");
    expect(surfaceFromProcessChain([
      { pid: 2, ppid: 1, tty: "??", command: "/Applications/ChatGPT.app/Contents/Resources/codex app-server" },
      { pid: 1, ppid: 0, tty: "??", command: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" },
    ])).toBe("gui");
    expect(surfaceFromProcessChain([
      { pid: 2, ppid: 1, tty: "??", command: "claude -p task" },
    ])).toBe("unknown");
    expect(surfaceFromProcessChain([
      { pid: 2, ppid: 1, tty: "?", command: "/usr/local/bin/codex exec task" },
    ])).toBe("cli");
    expect(surfaceFromProcessChain([
      { pid: 2, ppid: 1, tty: "??", command: "codex app-server" },
    ])).toBe("unknown");
    expect(surfaceFromProcessChain([
      { pid: 2, ppid: 1, tty: "ttys003", command: "codex" },
      { pid: 1, ppid: 0, tty: "??", command: "/Applications/Codex.app/Contents/MacOS/Codex" },
    ])).toBe("cli");
  });
});
