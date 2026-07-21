import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const projectCache = new Map<string, string | null>();

export function projectNameForCwd(cwd: string | null): string | null {
  if (!cwd) return null;
  const cached = projectCache.get(cwd);
  if (cached !== undefined) return cached;

  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, ".git"))) {
      const projectName = basename(current);
      projectCache.set(cwd, projectName);
      return projectName;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  projectCache.set(cwd, null);
  return null;
}
