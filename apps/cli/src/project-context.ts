import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface ProjectContext {
  name: string;
  root: string;
  identityKey: string;
}

export type EphemeralWorkspaceKind =
  | "system_temp"
  | "agent_scratch"
  | "agent_worktree"
  | "agent_runtime"
  | "managed_workspace";

const projectCache = new Map<string, ProjectContext | null>();
const ephemeralWorkspaceCache = new Map<string, EphemeralWorkspaceKind | null>();
const DATE_DIRECTORY = /^\d{4}-\d{2}-\d{2}$/u;

function isWithin(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate));
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function existingRealPath(path: string): string | null {
  try {
    return existsSync(path) ? realpathSync(path) : null;
  } catch {
    return null;
  }
}

function normalizedCandidates(path: string): string[] {
  const resolved = resolve(path);
  const real = existingRealPath(resolved);
  return real && real !== resolved ? [resolved, real] : [resolved];
}

function underAnyRoot(path: string, roots: string[]): boolean {
  return roots.some((root) => root && isWithin(root, path));
}

function isDatedScratch(path: string, root: string): boolean {
  if (!isWithin(root, path)) return false;
  const child = relative(resolve(root), resolve(path));
  const first = child.split(sep).filter(Boolean)[0];
  return Boolean(first && DATE_DIRECTORY.test(first));
}

function hasAgentWorktreeSegment(path: string): boolean {
  const segments = resolve(path).split(sep).filter(Boolean);
  return segments.some((segment, index) => (
    (segment === ".codex" || segment === ".claude")
    && (segments[index + 1] === "worktrees" || segments[index + 1] === "sandboxes")
  ));
}

export function ephemeralWorkspaceKind(path: string | null): EphemeralWorkspaceKind | null {
  if (!path) return null;
  if (ephemeralWorkspaceCache.has(path)) return ephemeralWorkspaceCache.get(path) ?? null;
  const home = homedir();
  const systemTempRoots = [
    tmpdir(),
    process.env.TMPDIR ?? "",
    process.env.TMP ?? "",
    process.env.TEMP ?? "",
    "/tmp",
    "/private/tmp",
    "/var/tmp",
    "/private/var/tmp",
    "/dev/shm",
  ];
  const agentWorktreeRoots = [
    resolve(home, ".codex/worktrees"),
    resolve(home, ".codex/sandboxes"),
    resolve(home, ".claude/worktrees"),
    resolve(home, ".claude/sandboxes"),
  ];
  const agentRuntimeRoots = [
    resolve(home, ".codex/.tmp"),
    resolve(home, ".codex/tmp"),
    resolve(home, ".codex/sessions"),
    resolve(home, ".codex/log"),
    resolve(home, ".codex/logs"),
    resolve(home, ".claude/.tmp"),
    resolve(home, ".claude/tmp"),
    resolve(home, ".claude/projects"),
    resolve(home, ".claude/debug"),
    resolve(home, ".claude/session-env"),
    resolve(home, ".claude/shell-snapshots"),
    resolve(home, ".claude/tasks"),
    resolve(home, ".claude/teams"),
  ];
  const managedWorkspaceRoots = [
    resolve(home, ".meee2/workspaces"),
    resolve(home, "multica_workspaces"),
  ];
  const datedScratchRoots = [
    resolve(home, "Documents/Codex"),
    resolve(home, "Documents/Claude"),
    resolve(home, "Documents/Claude Code"),
  ];

  for (const candidate of normalizedCandidates(path)) {
    if (underAnyRoot(candidate, systemTempRoots)) {
      ephemeralWorkspaceCache.set(path, "system_temp");
      return "system_temp";
    }
    if (datedScratchRoots.some((root) => isDatedScratch(candidate, root))) {
      ephemeralWorkspaceCache.set(path, "agent_scratch");
      return "agent_scratch";
    }
    if (underAnyRoot(candidate, agentWorktreeRoots) || hasAgentWorktreeSegment(candidate)) {
      ephemeralWorkspaceCache.set(path, "agent_worktree");
      return "agent_worktree";
    }
    if (underAnyRoot(candidate, agentRuntimeRoots)
      || /\/[^/]+\.app\/Contents\/Resources\/runtime(?:\/|$)/u.test(candidate)) {
      ephemeralWorkspaceCache.set(path, "agent_runtime");
      return "agent_runtime";
    }
    if (underAnyRoot(candidate, managedWorkspaceRoots)) {
      ephemeralWorkspaceCache.set(path, "managed_workspace");
      return "managed_workspace";
    }
  }
  ephemeralWorkspaceCache.set(path, null);
  return null;
}

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
  if (ephemeralWorkspaceKind(cwd)) return null;
  const context = projectContextForCwd(cwd);
  const root = resolve(context?.root ?? cwd);
  if (["/", homedir(), dirname(homedir())].includes(root) || ephemeralWorkspaceKind(root)) return null;
  return {
    legacyId: `project:${createHash("sha256").update(root).digest("hex").slice(0, 20)}`,
    name: context?.name ?? basename(root),
    root,
    identityKey: context?.identityKey ?? `path:${hash(root)}`,
  };
}
