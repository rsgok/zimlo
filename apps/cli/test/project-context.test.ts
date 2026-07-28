import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ephemeralWorkspaceKind, persistableProjectForCwd, projectContextForCwd } from "../src/project-context.js";

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("project context", () => {
  it("uses the repository root and remote identity for nested paths", () => {
    const root = mkdtempSync(join(tmpdir(), "zimlo-project-"));
    temporaryPaths.push(root);
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "remote", "add", "origin", "https://example.com/team/project.git"]);
    const nested = join(root, "src", "feature");
    mkdirSync(nested, { recursive: true });

    const context = projectContextForCwd(nested);

    expect(context?.root).toBe(realpathSync(root));
    expect(context?.name).toBe(root.split("/").at(-1));
    expect(context?.identityKey).toMatch(/^git-remote:/u);
  });

  it("falls back to a path identity when git cannot inspect the directory", () => {
    const missing = join(process.cwd(), `.zimlo-missing-${Date.now()}`);

    const project = persistableProjectForCwd(missing);

    expect(project?.root).toBe(missing);
    expect(project?.identityKey).toMatch(/^path:/u);
  });

  it.each([
    [join(tmpdir(), "codex-run"), "system_temp"],
    [join(homedir(), "Documents/Codex/2026-07-29/task/work"), "agent_scratch"],
    [join(homedir(), "Documents/Claude/2026-07-29/task"), "agent_scratch"],
    [join(homedir(), ".codex/worktrees/abcd/project"), "agent_worktree"],
    [join(homedir(), "Code/project/.claude/worktrees/agent-123"), "agent_worktree"],
    [join(homedir(), ".claude/projects/-private-tmp-project"), "agent_runtime"],
    ["/Applications/Zimlo.app/Contents/Resources/runtime/cli", "agent_runtime"],
    [join(homedir(), ".meee2/workspaces/global/canvas-123"), "managed_workspace"],
    [join(homedir(), "multica_workspaces/run/session/workdir"), "managed_workspace"],
  ] as const)("classifies generated workspace %s as %s", (path, kind) => {
    expect(ephemeralWorkspaceKind(path)).toBe(kind);
    expect(persistableProjectForCwd(path)).toBeNull();
  });

  it("keeps ordinary durable directories eligible", () => {
    const path = join(homedir(), "Code/product");
    expect(ephemeralWorkspaceKind(path)).toBeNull();
    expect(persistableProjectForCwd(path)?.root).toBe(path);
  });
});
