import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectNameForCwd } from "../src/project-context";

const created: string[] = [];

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("projectNameForCwd", () => {
  it("finds the nearest git project above the working directory", () => {
    const root = mkdtempSync(join(tmpdir(), "zimlo-project-"));
    created.push(root);
    mkdirSync(join(root, ".git"));
    const cwd = join(root, "apps", "web");
    mkdirSync(cwd, { recursive: true });

    expect(projectNameForCwd(cwd)).toBe(root.split("/").at(-1));
  });

  it("returns null outside a git project", () => {
    const cwd = mkdtempSync(join(tmpdir(), "zimlo-directory-"));
    created.push(cwd);
    expect(projectNameForCwd(cwd)).toBeNull();
  });
});
