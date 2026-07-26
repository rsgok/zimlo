import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { ApprovalCategory, ApprovalContext, Project, ProjectTrustPolicy } from "@zimlo/protocol";

const SAFE_CATEGORIES = new Set<ApprovalCategory>(["read", "search", "test", "build"]);

function shellSegments(command: string): string[] {
  return command
    .split(/(?:&&|\|\||;|\n)/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export function classifyCommandSegment(segment: string): ApprovalCategory {
  const value = segment.trim();
  if (!value) return "unknown";
  if (/\b(?:rm|rmdir|shred)\b|\bgit\s+(?:reset|clean)\b|\b(?:drop|truncate)\s+(?:table|database)\b|\bsudo\b/iu.test(value)) return "destructive";
  if (/\bgit\s+(?:push|commit|tag|merge|rebase)\b|\bgh\s+pr\s+(?:create|merge)\b/iu.test(value)) return "git_publish";
  if (/\b(?:curl|wget|ssh|scp|rsync)\b|\b(?:fetch|axios)\b|\bgh\s+(?!status\b|repo\s+view\b)/iu.test(value)) return "network";
  if (/\b(?:npm|pnpm|yarn|bun|pip|uv|cargo|gem|brew)\s+(?:add|install|update|upgrade)\b/iu.test(value)) return "install";
  if (/(?:^|\s)(?:apply_patch|tee)\b|(?:^|\s)(?:cp|mv|mkdir|touch)\b|(?:^|\s)sed\s+-i\b|(?:>|>>)\s*\S+/iu.test(value)) return "write";
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:test|typecheck|lint)\b|\b(?:vitest|jest|pytest|xcodebuild\s+test|swift\s+test|cargo\s+test)\b/iu.test(value)) return "test";
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?build\b|\b(?:tsc|vite\s+build|xcodebuild\s+build|swift\s+build|cargo\s+build)\b/iu.test(value)) return "build";
  if (/^(?:rg|grep|find|fd)\b/iu.test(value)) return "search";
  if (/^(?:pwd|ls|cat|head|tail|sed\s+-n|git\s+(?:status|diff|log|show)|stat|wc)\b/iu.test(value)) return "read";
  return "unknown";
}

function normalizedPath(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const missing: string[] = [];
  let cursor = absolute;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return absolute;
    missing.unshift(basename(cursor));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...missing);
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function commandStaysWithinProject(command: string, cwd: string, projectRoot: string): boolean {
  const root = normalizedPath(projectRoot);
  if (!isWithin(root, normalizedPath(cwd))) return false;
  const pathTokens = command.match(/(?:^|\s)(\/[^\s"'`;|&]+|\.{1,2}\/[^\s"'`;|&]*)/gu) ?? [];
  return pathTokens.every((token) => {
    const path = token.trim();
    return isWithin(root, normalizedPath(isAbsolute(path) ? path : resolve(cwd, path)));
  });
}

export function approvalContextForCommand(command: string, cwd: string | null, project: Project | null): ApprovalContext {
  const segments = shellSegments(command);
  const categories = segments.map(classifyCommandSegment);
  const category = categories.length > 0 && categories.every((value) => value === categories[0])
    ? categories[0]!
    : categories.some((value) => !SAFE_CATEGORIES.has(value))
      ? categories.find((value) => !SAFE_CATEGORIES.has(value)) ?? "unknown"
      : categories.includes("build")
        ? "build"
        : categories.includes("test")
          ? "test"
          : categories.includes("search")
            ? "search"
            : "read";
  const withinProject = Boolean(cwd && project?.primaryPath && commandStaysWithinProject(command, cwd, project.primaryPath));
  return {
    category,
    projectId: project?.id ?? null,
    cwd,
    command,
    segments,
    withinProject,
    reason: !project ? "无法关联项目" : !withinProject ? "命令路径无法确认位于项目内" : `识别为 ${category}`,
  };
}

export function approvalContextForFile(path: string | null, cwd: string | null, project: Project | null): ApprovalContext {
  const root = project?.primaryPath ? normalizedPath(project.primaryPath) : null;
  const candidate = path ? normalizedPath(isAbsolute(path) ? path : resolve(cwd ?? "", path)) : null;
  const withinProject = Boolean(root && candidate && isWithin(root, candidate));
  return {
    category: "write",
    projectId: project?.id ?? null,
    cwd,
    segments: [],
    withinProject,
    reason: withinProject ? "文件写入始终需要确认" : "写入路径不在可信项目内",
  };
}

export function canAutoAllow(context: ApprovalContext, policy: ProjectTrustPolicy): boolean {
  if (policy.preset !== "safe_automation" || !context.withinProject || !SAFE_CATEGORIES.has(context.category)) return false;
  if (context.segments.length === 0) return policy.autoAllow.includes(context.category);
  return context.segments.every((segment) => policy.autoAllow.includes(classifyCommandSegment(segment)));
}
