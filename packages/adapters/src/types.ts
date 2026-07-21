import type { EventKind, EventSource, Provider, Provenance } from "@zimlo/protocol";

export interface TranscriptMetadata {
  providerSessionId?: string;
  cwd?: string;
  title?: string;
  createdAt?: string;
  turnId?: string;
}

export interface EventDraft {
  kind: EventKind;
  source: EventSource;
  occurredAt: string;
  payload: unknown;
  provenance: Provenance;
  turnId?: string;
  itemId?: string;
}

export interface ToolCallState {
  name: string;
  input: Record<string, unknown>;
  command?: string;
}

export interface ParserState {
  provider: Provider;
  providerSessionId: string;
  currentTurnId?: string;
  toolCalls: Map<string, ToolCallState>;
}

export interface ParsedLine {
  metadata?: TranscriptMetadata;
  events: EventDraft[];
}

export interface ProcessSnapshot {
  pid: number;
  ppid: number;
  provider: Provider;
  startedAt: string;
  tty: string | null;
  command: string;
  providerSessionId: string | null;
  sessionBearing: boolean;
  cwd: string | null;
  transcriptPaths: string[];
}

export interface TranscriptCandidate {
  provider: Provider;
  path: string;
  providerSessionId: string;
  modifiedAt: string;
  size: number;
}
