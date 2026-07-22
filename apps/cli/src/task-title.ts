import { basename } from "node:path";
import type { Session } from "@zimlo/protocol";

export function taskTitleFromInput(input: string, maxLength = 56): string {
  const comment = input.match(/(?:^|\n)Comment:\s*([^\n]+)/iu)?.[1]?.trim();
  const requested = input.match(/##\s*My request for (?:Codex|Claude(?: Code)?):\s*([\s\S]+)/iu)?.[1]?.trim();
  const compact = (comment || requested || input)
    .replace(/<[^>]+>/gu, " ")
    .replace(/^[\s#>*`\-\d.)]+/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!compact) return "";
  return compact.length > maxLength ? `${compact.slice(0, maxLength).trimEnd()}…` : compact;
}

export function hasGeneratedSessionTitle(session: Session): boolean {
  if (/^(?:Codex|Claude) · 活跃进程 \d+$/u.test(session.title)) return true;
  const provider = session.provider === "codex" ? "Codex" : "Claude";
  const suffix = session.title.startsWith(`${provider} · `) ? session.title.slice(provider.length + 3) : null;
  if (!suffix) return false;
  return suffix === session.providerSessionId.slice(0, 8)
    || suffix === (session.cwd ? basename(session.cwd) : null)
    || /^[0-9a-f]{8}$/iu.test(suffix);
}

export function titleSessionFromInput(session: Session, input: string | null): Session {
  if (!input || !hasGeneratedSessionTitle(session)) return session;
  const title = taskTitleFromInput(input);
  return title ? { ...session, title } : session;
}
