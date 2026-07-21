import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import fg from "fast-glob";
import type { Provider } from "@zimlo/protocol";
import type { TranscriptCandidate } from "./types.js";

const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/iu;

export function providerSessionIdFromPath(provider: Provider, path: string): string {
  const match = path.match(UUID);
  if (match?.[1]) return match[1];
  return `${provider}-${basename(path, ".jsonl")}`;
}

async function candidatesFor(
  provider: Provider,
  pattern: string,
  cutoff: number,
  limit: number,
): Promise<TranscriptCandidate[]> {
  const paths = await fg(pattern, { absolute: true, onlyFiles: true, suppressErrors: true });
  const candidates = await Promise.all(
    paths
      .filter((path) => !path.includes("/subagents/"))
      .map(async (path): Promise<TranscriptCandidate | null> => {
        try {
          const file = await stat(path);
          if (file.mtimeMs < cutoff) return null;
          return {
            provider,
            path,
            providerSessionId: providerSessionIdFromPath(provider, path),
            modifiedAt: file.mtime.toISOString(),
            size: file.size,
          };
        } catch {
          return null;
        }
      }),
  );
  return candidates
    .filter((candidate): candidate is TranscriptCandidate => Boolean(candidate))
    .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
    .slice(0, limit);
}

export async function discoverTranscripts(options: {
  retentionDays?: number;
  limitPerProvider?: number;
} = {}): Promise<TranscriptCandidate[]> {
  const retentionDays = options.retentionDays ?? 7;
  const limit = options.limitPerProvider ?? 200;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const home = homedir();
  const [codex, claude] = await Promise.all([
    candidatesFor("codex", join(home, ".codex/sessions/**/rollout-*.jsonl"), cutoff, limit),
    candidatesFor("claude", join(home, ".claude/projects/**/*.jsonl"), cutoff, limit),
  ]);
  return [...codex, ...claude];
}
