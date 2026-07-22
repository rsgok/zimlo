import type { Provider, Session, SessionSurface } from "@zimlo/protocol";

export function runtimeLabel(provider: Provider): string {
  return provider === "claude" ? "Claude Code" : "Codex";
}

export function surfaceLabel(surface: SessionSurface): string {
  if (surface === "gui") return "GUI";
  if (surface === "cli") return "CLI";
  if (surface === "managed") return "Zimlo 托管";
  return "来源未知";
}

export function sessionRuntimeLabel(session: Pick<Session, "provider" | "surface">): string {
  return `${runtimeLabel(session.provider)} · ${surfaceLabel(session.surface)}`;
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

export function conciseTaskInput(input: string, maxLength = 560): string {
  const comment = input.match(/(?:^|\n)Comment:\s*([^\n]+)/iu)?.[1]?.trim();
  const requested = input.match(/##\s*My request for (?:Codex|Claude(?: Code)?):\s*([\s\S]+)/iu)?.[1]?.trim();
  const source = comment || requested || input;
  const readable = source
    .replace(/<[^>]+>/gu, " ")
    .replace(/^(?:File|Side|Lines|PDF path|PDF page|PDF annotation|Annotated .* screenshot|selected text):.*$/gimu, "")
    .replace(/^#+\s*/gmu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return readable.length > maxLength ? `${readable.slice(0, maxLength).trimEnd()}…` : readable;
}
