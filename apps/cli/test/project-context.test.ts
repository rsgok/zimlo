import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { persistableProjectForCwd, projectContextForCwd } from "../src/project-context.js";

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
    const missing = join(tmpdir(), `zimlo-missing-${Date.now()}`);

    const project = persistableProjectForCwd(missing);

    expect(project?.root).toBe(missing);
    expect(project?.identityKey).toMatch(/^path:/u);
  });
});
