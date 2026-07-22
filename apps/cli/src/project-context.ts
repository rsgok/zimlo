import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

interface ProjectContext {
  name: string;
  root: string;
}

const projectCache = new Map<string, ProjectContext | null>();

export function projectContextForCwd(cwd: string | null): ProjectContext | null {
  if (!cwd) return null;
  const cached = projectCache.get(cwd);
  if (cached !== undefined) return cached;

  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, ".git"))) {
      const context = { name: basename(current), root: current };
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
