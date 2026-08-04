import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { requireAgentCommand, resolveAgentCommand } from "../src/agent-command.js";

describe("agent command discovery", () => {
  const original = {
    codex: process.env.ZIMLO_CODEX_BIN,
    claude: process.env.ZIMLO_CLAUDE_BIN,
  };
  let root: string | null = null;

  afterEach(async () => {
    if (original.codex === undefined) delete process.env.ZIMLO_CODEX_BIN;
    else process.env.ZIMLO_CODEX_BIN = original.codex;
    if (original.claude === undefined) delete process.env.ZIMLO_CLAUDE_BIN;
    else process.env.ZIMLO_CLAUDE_BIN = original.claude;
    if (root) await rm(root, { recursive: true, force: true });
    root = null;
  });

  it("uses an explicit executable override for GUI-launched apps", async () => {
    root = await mkdtemp(join(tmpdir(), "zimlo-agent-command-"));
    const command = join(root, "codex");
    await writeFile(command, "#!/bin/sh\nexit 0\n");
    await chmod(command, 0o755);
    process.env.ZIMLO_CODEX_BIN = command;
    expect(await resolveAgentCommand("codex")).toBe(command);
  });

  it("rejects a missing override instead of claiming the agent exists", async () => {
    process.env.ZIMLO_CLAUDE_BIN = "/missing/claude";
    expect(await resolveAgentCommand("claude")).toBeNull();
  });

  it("returns the absolute command used by managed runtimes", async () => {
    root = await mkdtemp(join(tmpdir(), "zimlo-managed-command-"));
    const command = join(root, "codex");
    await writeFile(command, "#!/bin/sh\nexit 0\n");
    await chmod(command, 0o755);
    process.env.ZIMLO_CODEX_BIN = command;

    expect(await requireAgentCommand("codex")).toBe(command);
  });

  it("gives an actionable error when a managed runtime is unavailable", async () => {
    process.env.ZIMLO_CODEX_BIN = "/missing/codex";
    await expect(requireAgentCommand("codex")).rejects.toThrow("请确认应用已安装，或在 Zimlo 设置中检查 Runtime 接入");
  });
});
