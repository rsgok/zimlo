import { findExitCode, isTestCommand, readCommand } from "./test-detection.js";
import type { EventDraft, ParsedLine, ParserState, TranscriptMetadata } from "./types.js";
import { userInstructionText } from "./user-instruction.js";

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function occurredAt(record: Record<string, unknown>): string {
  return typeof record.timestamp === "string" ? record.timestamp : new Date().toISOString();
}

function event(
  kind: EventDraft["kind"],
  at: string,
  payload: unknown,
  state: ParserState,
  itemId?: string,
): EventDraft {
  return {
    kind,
    source: "transcript",
    occurredAt: at,
    payload,
    provenance: "verified",
    ...(state.currentTurnId ? { turnId: state.currentTurnId } : {}),
    ...(itemId ? { itemId } : {}),
  };
}

function contentBlocks(message: Record<string, unknown>): unknown[] {
  return Array.isArray(message.content) ? message.content : [];
}

export function parseClaudeLine(line: string, state: ParserState): ParsedLine {
  let record: Record<string, unknown>;
  try {
    record = objectValue(JSON.parse(line));
  } catch {
    return { events: [] };
  }

  const at = occurredAt(record);
  const events: EventDraft[] = [];
  const type = typeof record.type === "string" ? record.type : "";
  const sessionId = typeof record.sessionId === "string" ? record.sessionId : state.providerSessionId;
  const metadata: TranscriptMetadata = {
    providerSessionId: sessionId,
    ...(typeof record.cwd === "string" ? { cwd: record.cwd } : {}),
  };
  if (typeof record.uuid === "string") state.currentTurnId = record.uuid;

  if (type === "system") {
    const subtype = typeof record.subtype === "string" ? record.subtype : "";
    if (subtype === "init") {
      events.push(event("session_started", at, { cwd: record.cwd, model: record.model }, state));
    } else if (/error|failure/iu.test(subtype)) {
      events.push(event("failed", at, record, state));
    } else if (subtype === "session_end") {
      events.push(event("session_ended", at, record, state));
    }
  }

  if (type === "assistant") {
    const message = objectValue(record.message);
    for (const rawBlock of contentBlocks(message)) {
      const block = objectValue(rawBlock);
      if (block.type !== "tool_use") continue;
      const id = String(block.id ?? `tool-${state.toolCalls.size + 1}`);
      const name = typeof block.name === "string" ? block.name : "unknown";
      const input = objectValue(block.input);
      const command = readCommand(input);
      state.toolCalls.set(id, { name, input, ...(command ? { command } : {}) });

      if (name === "AskUserQuestion") {
        events.push(event("needs_input", at, { name, input }, state, id));
      } else if (["Edit", "Write", "NotebookEdit"].includes(name)) {
        events.push(event("files_changed", at, { name, input, phase: "proposed" }, state, id));
      } else if (name === "Bash") {
        events.push(event("command_started", at, { name, command, input }, state, id));
      }
    }

    if (message.stop_reason === "end_turn") {
      const text = contentBlocks(message)
        .map((raw) => objectValue(raw))
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n");
      if (text) {
        events.push({
          ...event("completed", at, { message: text }, state),
          provenance: "agent_reported",
        });
      }
    }
  }

  if (type === "user") {
    const message = objectValue(record.message);
    const prompt = userInstructionText(message.content);
    if (prompt) events.push(event("user_instruction", at, { prompt }, state));
    for (const rawBlock of contentBlocks(message)) {
      const block = objectValue(rawBlock);
      if (block.type !== "tool_result") continue;
      const callId = String(block.tool_use_id ?? "unknown");
      const call = state.toolCalls.get(callId);
      const output = block.content ?? block;
      const explicitError = block.is_error === true;
      const exitCode = explicitError ? 1 : findExitCode(output);
      if (call?.command && isTestCommand(call.command) && exitCode !== null) {
        events.push(event(exitCode === 0 ? "tests_passed" : "tests_failed", at, {
          command: call.command,
          exitCode,
          output,
        }, state, callId));
      } else {
        events.push(event("command_completed", at, { name: call?.name, exitCode, output }, state, callId));
      }
      state.toolCalls.delete(callId);
    }
  }

  return { metadata, events };
}
