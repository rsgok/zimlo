import { open, stat } from "node:fs/promises";
import { basename } from "node:path";
import {
  discoverTranscripts,
  parseClaudeLine,
  parseCodexLine,
  scanAgentProcesses,
  stableEventId,
  stableSessionId,
  type ParserState,
  type TranscriptCandidate,
} from "@zimlo/adapters";
import { EMPTY_CAPABILITIES, type Session, type UnifiedEvent } from "@zimlo/protocol";
import { RuntimeHub } from "./runtime.js";

const INITIAL_HEAD_BYTES = 64 * 1024;
const INITIAL_TAIL_BYTES = 512 * 1024;
const INCREMENTAL_BYTES = 2 * 1024 * 1024;

interface FileState {
  parser: ParserState;
  createdAt: string;
  cwd: string | null;
  title: string;
}

function defaultTitle(candidate: TranscriptCandidate, cwd: string | null): string {
  const location = cwd ? basename(cwd) : candidate.providerSessionId.slice(0, 8);
  return `${candidate.provider === "codex" ? "Codex" : "Claude"} · ${location}`;
}

export class DiscoveryService {
  private readonly runtime: RuntimeHub;
  private readonly files = new Map<string, TranscriptCandidate>();
  private readonly states = new Map<string, FileState>();
  private tailTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private processTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private scanningProcesses = false;

  constructor(runtime: RuntimeHub) {
    this.runtime = runtime;
  }

  async start(): Promise<void> {
    await this.refreshCandidates();
    await Promise.all([...this.files.values()].map((candidate) => this.ingestCandidate(candidate)));
    this.runtime.store.prune(7);
    await this.scanProcesses();
    this.tailTimer = setInterval(() => void this.tailKnownFiles(), 2_000);
    this.refreshTimer = setInterval(() => void this.refreshCandidates(true), 2_000);
    this.processTimer = setInterval(() => void this.scanProcesses(), 2_000);
    this.pruneTimer = setInterval(() => this.runtime.store.prune(7), 6 * 60 * 60 * 1000);
    this.tailTimer.unref();
    this.refreshTimer.unref();
    this.processTimer.unref();
    this.pruneTimer.unref();
  }

  stop(): void {
    if (this.tailTimer) clearInterval(this.tailTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.processTimer) clearInterval(this.processTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
  }

  private async refreshCandidates(ingestNew = false): Promise<void> {
    const candidates = await discoverTranscripts();
    for (const candidate of candidates) {
      const isNew = !this.files.has(candidate.path);
      this.files.set(candidate.path, candidate);
      if (isNew && ingestNew) await this.ingestCandidate(candidate);
    }
  }

  private async tailKnownFiles(): Promise<void> {
    for (const candidate of this.files.values()) {
      try {
        const file = await stat(candidate.path);
        if (file.size !== candidate.size || file.mtime.toISOString() !== candidate.modifiedAt) {
          candidate.size = file.size;
          candidate.modifiedAt = file.mtime.toISOString();
          await this.ingestCandidate(candidate);
        }
      } catch {
        // Transcript may be atomically replaced; the next refresh will recover it.
      }
    }
  }

  private stateFor(candidate: TranscriptCandidate): FileState {
    const existing = this.states.get(candidate.path);
    if (existing) return existing;
    const created: FileState = {
      parser: {
        provider: candidate.provider,
        providerSessionId: candidate.providerSessionId,
        toolCalls: new Map(),
      },
      createdAt: candidate.modifiedAt,
      cwd: null,
      title: defaultTitle(candidate, null),
    };
    this.states.set(candidate.path, created);
    return created;
  }

  private async ingestCandidate(candidate: TranscriptCandidate): Promise<void> {
    const state = this.stateFor(candidate);
    const priorOffset = this.runtime.store.getOffset(candidate.path);
    const file = await open(candidate.path, "r");
    try {
      if (priorOffset === null) {
        const headLength = Math.min(candidate.size, INITIAL_HEAD_BYTES);
        await this.readAndParse(file, candidate, state, 0, headLength, false);
        if (candidate.size > headLength) {
          const tailStart = Math.max(headLength, candidate.size - INITIAL_TAIL_BYTES);
          await this.readAndParse(file, candidate, state, tailStart, candidate.size - tailStart, tailStart > 0);
        }
        this.runtime.store.setOffset(candidate.path, candidate.size, candidate.size, candidate.modifiedAt);
      } else {
        const start = candidate.size < priorOffset ? 0 : priorOffset;
        const length = Math.min(candidate.size - start, INCREMENTAL_BYTES);
        if (length > 0) {
          const consumed = await this.readAndParse(file, candidate, state, start, length, start > 0);
          this.runtime.store.setOffset(candidate.path, start + consumed, candidate.size, candidate.modifiedAt);
        }
      }
      this.ensureSession(candidate, state, candidate.modifiedAt, true);
    } finally {
      await file.close();
    }
  }

  private async readAndParse(
    file: Awaited<ReturnType<typeof open>>,
    candidate: TranscriptCandidate,
    state: FileState,
    start: number,
    length: number,
    skipPartialFirstLine: boolean,
  ): Promise<number> {
    if (length <= 0) return 0;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, start);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline < 0) return 0;
    const complete = text.slice(0, lastNewline + 1);
    const lines = complete.split("\n");
    let byteOffset = start;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const lineBytes = Buffer.byteLength(`${line}\n`);
      if (!(skipPartialFirstLine && index === 0) && line.trim()) {
        const parsed = candidate.provider === "codex"
          ? parseCodexLine(line, state.parser)
          : parseClaudeLine(line, state.parser);
        if (parsed.metadata?.providerSessionId) state.parser.providerSessionId = parsed.metadata.providerSessionId;
        if (parsed.metadata?.cwd) {
          state.cwd = parsed.metadata.cwd;
          if (state.title === defaultTitle(candidate, null)) state.title = defaultTitle(candidate, state.cwd);
        }
        if (parsed.metadata?.createdAt) state.createdAt = parsed.metadata.createdAt;
        if (parsed.metadata?.title) state.title = parsed.metadata.title;
        const session = this.ensureSession(candidate, state, candidate.modifiedAt);
        parsed.events.forEach((draft, eventIndex) => {
          const event: UnifiedEvent = {
            id: stableEventId(candidate.path, byteOffset, eventIndex, line),
            sequence: 0,
            provider: candidate.provider,
            sessionId: session.id,
            providerSessionId: state.parser.providerSessionId,
            ...(draft.turnId ? { turnId: draft.turnId } : {}),
            ...(draft.itemId ? { itemId: draft.itemId } : {}),
            kind: draft.kind,
            source: draft.source,
            occurredAt: draft.occurredAt,
            payload: draft.payload,
            provenance: draft.provenance,
          };
          this.runtime.ingestEvent(event);
        });
      }
      byteOffset += lineBytes;
    }
    return Buffer.byteLength(complete);
  }

  private ensureSession(
    candidate: TranscriptCandidate,
    state: FileState,
    lastActivityAt: string,
    broadcast = false,
  ): Session {
    const providerSessionId = state.parser.providerSessionId || candidate.providerSessionId;
    const id = stableSessionId(candidate.provider, providerSessionId);
    const existing = this.runtime.store.getSession(id);
    const cwd = state.cwd ?? existing?.cwd ?? null;
    const canResume = existing?.activePid === null || existing?.activePid === undefined;
    const capabilities = {
      ...(existing?.capabilities ?? EMPTY_CAPABILITIES),
      discovered: true,
      replyable: canResume && cwd !== null,
      resumable: canResume && cwd !== null,
    };
    const session: Session = {
      id,
      provider: candidate.provider,
      surface: existing?.surface ?? "unknown",
      providerSessionId,
      title: state.title || defaultTitle(candidate, state.cwd),
      cwd,
      transcriptPath: candidate.path,
      status: existing?.activePid ? "running" : (existing?.status ?? "idle"),
      lastActivityAt,
      createdAt: state.createdAt,
      activePid: existing?.activePid ?? null,
      processStartedAt: existing?.processStartedAt ?? null,
      tty: existing?.tty ?? null,
      correlationUncertain: false,
      capabilities,
    };
    return broadcast ? this.runtime.upsertSession(session) : this.runtime.store.upsertSession(session);
  }

  private async scanProcesses(): Promise<void> {
    if (this.scanningProcesses) return;
    this.scanningProcesses = true;
    try {
      const processes = await scanAgentProcesses();
      const activePids = new Set(processes.filter((process) => process.sessionBearing).map((process) => process.pid));
      for (const process of processes) {
        const strongSession = process.providerSessionId
          ? this.runtime.store.getSessionByProviderId(process.provider, process.providerSessionId)
          : null;
        if (strongSession) {
          activePids.add(process.pid);
          this.runtime.upsertSession({
            ...strongSession,
            surface: process.tty ? "cli" : strongSession.surface,
            cwd: process.cwd ?? strongSession.cwd,
            status: "running",
            activePid: process.pid,
            processStartedAt: process.startedAt,
            tty: process.tty,
            correlationUncertain: false,
            capabilities: { ...strongSession.capabilities, liveObserved: true, replyable: false, resumable: false },
          });
          continue;
        }
        const transcriptPath = process.transcriptPaths.find((path) => this.files.has(path));
        if (transcriptPath) {
          activePids.add(process.pid);
          const candidate = this.files.get(transcriptPath)!;
          const state = this.stateFor(candidate);
          const session = this.ensureSession(candidate, state, candidate.modifiedAt);
          this.runtime.upsertSession({
            ...session,
            surface: process.tty ? "cli" : session.surface,
            cwd: process.cwd ?? session.cwd,
            status: "running",
            activePid: process.pid,
            processStartedAt: process.startedAt,
            tty: process.tty,
            capabilities: { ...session.capabilities, liveObserved: true, replyable: false, resumable: false },
          });
          continue;
        }

        if (!process.sessionBearing) continue;

        const providerSessionId = `process:${process.pid}:${process.startedAt}`;
        const id = stableSessionId(process.provider, providerSessionId);
        this.runtime.upsertSession({
          id,
          provider: process.provider,
          surface: process.tty ? "cli" : "unknown",
          providerSessionId,
          title: `${process.provider === "codex" ? "Codex" : "Claude"} · 活跃进程 ${process.pid}`,
          cwd: process.cwd,
          transcriptPath: null,
          status: "running",
          lastActivityAt: new Date().toISOString(),
          createdAt: process.startedAt,
          activePid: process.pid,
          processStartedAt: process.startedAt,
          tty: process.tty,
          correlationUncertain: true,
          capabilities: { ...EMPTY_CAPABILITIES, liveObserved: true, resumable: false },
        });
      }
      const cleared = this.runtime.store.clearInactiveProcesses(activePids);
      for (const session of cleared.changed) {
        this.runtime.send({ type: "session.updated", session });
      }
      for (const sessionId of cleared.removed) this.runtime.send({ type: "session.removed", sessionId });

      // A different process in the same cwd is not evidence that this exact
      // provider session is occupied. Strong hook/transcript identities stay
      // replyable; ResumeService re-checks the provider thread before sending.
    } finally {
      this.scanningProcesses = false;
    }
  }
}
