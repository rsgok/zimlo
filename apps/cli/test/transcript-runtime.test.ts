import { afterEach, describe, expect, it } from "vitest";
import { parseCodexLine, stableSessionId, uuidV7, type ParserState } from "@zimlo/adapters";
import { EMPTY_CAPABILITIES, type Session, type UnifiedEvent } from "@zimlo/protocol";
import { RuntimeHub } from "../src/runtime.js";
import { ZimloStore } from "../src/store.js";

describe("transcript-only runtime", () => {
  const stores: ZimloStore[] = [];

  afterEach(() => stores.splice(0).forEach((store) => store.close()));

  it("reconstructs task input, verification, and completion without any Hook event", () => {
    const store = new ZimloStore(":memory:");
    stores.push(store);
    const runtime = new RuntimeHub(store);
    const parser: ParserState = { provider: "codex", providerSessionId: "fallback", toolCalls: new Map() };
    const lines = [
      '{"timestamp":"2026-08-04T01:00:00.000Z","type":"session_meta","payload":{"id":"transcript-run","cwd":"/tmp/transcript-project"}}',
      '{"timestamp":"2026-08-04T01:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"优化 Hook 数量"}]}}',
      '{"timestamp":"2026-08-04T01:00:02.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"test-1","arguments":"{\\"cmd\\":\\"pnpm test\\"}"}}',
      '{"timestamp":"2026-08-04T01:00:03.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"test-1","output":{"exit_code":0,"output":"passed"}}}',
      '{"timestamp":"2026-08-04T01:00:04.000Z","type":"event_msg","payload":{"type":"task_complete"}}',
    ];
    const parsed = lines.map((line) => parseCodexLine(line, parser));
    const metadata = parsed.find((item) => item.metadata?.providerSessionId)?.metadata;
    const providerSessionId = metadata?.providerSessionId ?? parser.providerSessionId;
    const sessionId = stableSessionId("codex", providerSessionId);
    const session: Session = {
      id: sessionId,
      provider: "codex",
      surface: "gui",
      providerSessionId,
      title: "Codex · transcript",
      cwd: metadata?.cwd ?? null,
      transcriptPath: "/tmp/transcript.jsonl",
      status: "running",
      lastActivityAt: "2026-08-04T01:00:00.000Z",
      createdAt: "2026-08-04T01:00:00.000Z",
      activePid: null,
      processStartedAt: null,
      tty: null,
      correlationUncertain: false,
      capabilities: EMPTY_CAPABILITIES,
    };
    runtime.upsertSession(session);

    parsed.flatMap((item) => item.events).forEach((draft) => runtime.ingestEvent({
      id: uuidV7(),
      sequence: 0,
      provider: "codex",
      sessionId,
      providerSessionId,
      ...draft,
    } satisfies UnifiedEvent));

    const events = store.listEvents(sessionId);
    expect(events.map((event) => event.kind)).toEqual([
      "session_started", "user_instruction", "command_started", "tests_passed", "completed",
    ]);
    expect(events.every((event) => event.source === "transcript")).toBe(true);
    expect(events.find((event) => event.kind === "user_instruction")?.payload).toEqual({ prompt: "优化 Hook 数量" });
    expect(store.getSession(sessionId)).toMatchObject({ status: "completed" });
    expect(store.listFeedPosts()).toEqual([]);
  });
});
