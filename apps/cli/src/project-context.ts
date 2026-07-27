import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

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

  const root = gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
  if (root) {
    const resolvedRoot = resolve(root);
    const context = { name: basename(resolvedRoot), root: resolvedRoot, identityKey: gitIdentityKey(resolvedRoot) };
    projectCache.set(cwd, context);
    return context;
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
  const origin = gitOutput(root, ["config", "--get", "remote.origin.url"]);
  if (origin) return `git-remote:${hash(origin.replace(/\.git$/u, "").toLowerCase())}`;
  const rootCommit = gitOutput(root, ["rev-list", "--max-parents=0", "HEAD"])?.split("\n")[0];
  if (rootCommit) return `git-root:${rootCommit}`;
  return `path:${hash(root)}`;
}

function gitOutput(root: string, args: string[]): string | null {
  try {
    const value = execFileSync("git", ["-C", resolve(root), ...args], {
      encoding: "utf8",
      timeout: 1_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value || null;
  } catch {
    // A protected, missing, or non-repository path must never block startup.
    return null;
  }
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
