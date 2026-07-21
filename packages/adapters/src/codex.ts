import { findExitCode, isTestCommand, readCommand } from "./test-detection.js";
import type { EventDraft, ParsedLine, ParserState, TranscriptMetadata } from "./types.js";

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return objectValue(value);
  try {
    return objectValue(JSON.parse(value));
  } catch {
    return { raw: value };
  }
}

function timestamp(record: Record<string, unknown>): string {
  return typeof record.timestamp === "string" ? record.timestamp : new Date().toISOString();
}

function draft(
  kind: EventDraft["kind"],
  occurredAt: string,
  payload: unknown,
  state: ParserState,
  options: { itemId?: string; provenance?: EventDraft["provenance"] } = {},
): EventDraft {
  return {
    kind,
    source: "transcript",
    occurredAt,
    payload,
    provenance: options.provenance ?? "verified",
    ...(state.currentTurnId ? { turnId: state.currentTurnId } : {}),
    ...(options.itemId ? { itemId: options.itemId } : {}),
  };
}

export function parseCodexLine(line: string, state: ParserState): ParsedLine {
  let record: Record<string, unknown>;
  try {
    record = objectValue(JSON.parse(line));
  } catch {
    return { events: [] };
  }

  const occurredAt = timestamp(record);
  const type = typeof record.type === "string" ? record.type : "";
  const payload = objectValue(record.payload);
  const events: EventDraft[] = [];
  let metadata: TranscriptMetadata | undefined;

  if (type === "session_meta") {
    const id = typeof payload.id === "string" ? payload.id : state.providerSessionId;
    metadata = {
      providerSessionId: id,
      ...(typeof payload.cwd === "string" ? { cwd: payload.cwd } : {}),
      ...(typeof payload.timestamp === "string" ? { createdAt: payload.timestamp } : {}),
    };
    events.push(draft("session_started", occurredAt, { cwd: payload.cwd, source: payload.source }, state));
  }

  if (type === "turn_context") {
    if (typeof payload.turn_id === "string") state.currentTurnId = payload.turn_id;
    metadata = {
      ...(typeof payload.cwd === "string" ? { cwd: payload.cwd } : {}),
      ...(state.currentTurnId ? { turnId: state.currentTurnId } : {}),
    };
  }

  if (type === "event_msg") {
    const eventType = typeof payload.type === "string" ? payload.type : "";
    if (typeof payload.turn_id === "string") state.currentTurnId = payload.turn_id;
    if (["task_started", "turn_started"].includes(eventType)) {
      events.push(draft("session_started", occurredAt, payload, state));
    } else if (["plan_update", "plan_updated"].includes(eventType)) {
      events.push(draft("plan_updated", occurredAt, payload, state));
    } else if (["task_complete", "turn_complete"].includes(eventType)) {
      events.push(draft("completed", occurredAt, payload, state));
    } else if (["turn_aborted", "error"].includes(eventType)) {
      events.push(draft("failed", occurredAt, payload, state));
    }
  }

  if (type === "response_item") {
    const itemType = typeof payload.type === "string" ? payload.type : "";
    if (itemType === "function_call" || itemType === "custom_tool_call") {
      const name = typeof payload.name === "string" ? payload.name : "unknown";
      const callId = String(payload.call_id ?? payload.id ?? `call-${state.toolCalls.size + 1}`);
      const input = parseArguments(payload.arguments ?? payload.input);
      const command = readCommand(input);
      state.toolCalls.set(callId, { name, input, ...(command ? { command } : {}) });

      if (/request_user_input|ask_user/iu.test(name)) {
        events.push(draft("needs_input", occurredAt, { name, input }, state, { itemId: callId }));
      } else if (/apply_patch|write|edit/iu.test(name)) {
        events.push(draft("files_changed", occurredAt, { name, input, phase: "proposed" }, state, { itemId: callId }));
      } else if (/exec|shell|command|bash/iu.test(name)) {
        events.push(draft("command_started", occurredAt, { name, command, input }, state, { itemId: callId }));
      }
    }

    if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
      const callId = String(payload.call_id ?? payload.id ?? "unknown");
      const call = state.toolCalls.get(callId);
      const output = payload.output ?? payload.result ?? payload;
      const exitCode = findExitCode(output);
      if (call?.command && isTestCommand(call.command) && exitCode !== null) {
        events.push(
          draft(exitCode === 0 ? "tests_passed" : "tests_failed", occurredAt, {
            command: call.command,
            exitCode,
            output,
          }, state, { itemId: callId }),
        );
      } else {
        events.push(draft("command_completed", occurredAt, { name: call?.name, exitCode, output }, state, { itemId: callId }));
      }
      state.toolCalls.delete(callId);
    }

    if (itemType === "message" && payload.role === "assistant") {
      const phase = payload.phase;
      if (phase === "final_answer") {
        events.push(draft("completed", occurredAt, { message: payload.content }, state, { provenance: "agent_reported" }));
      }
    }
  }

  return { ...(metadata ? { metadata } : {}), events };
}
