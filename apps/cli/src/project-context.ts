import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

interface ProjectContext {
  name: string;
  root: string;
  identityKey: string;
}

const projectCache = new Map<string, ProjectContext | null>();

export function projectContextForCwd(cwd: string | null): ProjectContext | null {
  if (!cwd) return null;
  const cached = projectCache.get(cwd);
  if (cached !== undefined) return cached;

  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, ".git"))) {
      const context = { name: basename(current), root: current, identityKey: gitIdentityKey(current) };
      projectCache.set(cwd, context);
      return context;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  projectCache.set(cwd, null);
  return null;
}

export function projectNameForCwd(cwd: string | null): string | null {
  return projectContextForCwd(cwd)?.name ?? null;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function gitIdentityKey(root: string): string {
  const dotGit = join(root, ".git");
  try {
    const configPath = statSync(dotGit).isDirectory()
      ? join(dotGit, "config")
      : join(resolve(root, readFileSync(dotGit, "utf8").trim().replace(/^gitdir:\s*/u, "")), "config");
    const config = readFileSync(configPath, "utf8");
    const origin = config.match(/\[remote\s+"origin"\][\s\S]*?\n\s*url\s*=\s*([^\n]+)/iu)?.[1]?.trim();
    if (origin) return `git-remote:${hash(origin.replace(/\.git$/u, "").toLowerCase())}`;
  } catch {
    // Repositories without a readable origin fall back to their root commit.
  }
  try {
    const rootCommit = execFileSync("git", ["-C", root, "rev-list", "--max-parents=0", "HEAD"], { encoding: "utf8", timeout: 1_000, stdio: ["ignore", "pipe", "ignore"] })
      .trim().split("\n")[0];
    if (rootCommit) return `git-root:${rootCommit}`;
  } catch {
    // Empty repositories have no commit identity yet.
  }
  return `path:${hash(root)}`;
}

export function persistableProjectForCwd(cwd: string | null): (ProjectContext & { legacyId: string }) | null {
  if (!cwd) return null;
  const context = projectContextForCwd(cwd);
  const root = resolve(context?.root ?? cwd);
  if (["/", homedir(), dirname(homedir())].includes(root)) return null;
  return {
    legacyId: `project:${createHash("sha256").update(root).digest("hex").slice(0, 20)}`,
    name: context?.name ?? basename(root),
    root,
    identityKey: context?.identityKey ?? `path:${hash(root)}`,
  };
}
