import type { Provider, Session } from "@zimlo/protocol";

export function runtimeLabel(provider: Provider): string {
  return provider === "claude" ? "Claude Code" : "Codex";
}

export function lastPathSegment(path: string | null): string | null {
  if (!path) return null;
  const segments = path.replace(/[\\/]+$/u, "").split(/[\\/]/u).filter(Boolean);
  return segments.at(-1) ?? null;
}

export function sessionLocation(session: Session): { kind: "project" | "directory"; label: string } {
  if (session.projectName) return { kind: "project", label: session.projectName };
  return { kind: "directory", label: lastPathSegment(session.cwd) ?? "工作目录未知" };
}
