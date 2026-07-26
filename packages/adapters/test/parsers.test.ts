import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyAgentCommand, parseClaudeLine, parseCodexLine, redactText, redactUnknown } from "../src/index.js";
import type { ParserState } from "../src/types.js";

function fixture(name: string): string[] {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").trim().split("\n");
}

describe("Codex 0.144.6 fixture contract", () => {
  it("extracts metadata and only verifies tests with an exit code", () => {
    const state: ParserState = { provider: "codex", providerSessionId: "fallback", toolCalls: new Map() };
    const parsed = fixture("codex-0.144.6.jsonl").map((line) => parseCodexLine(line, state));
    expect(parsed[0]?.metadata).toMatchObject({ providerSessionId: "codex-fixture-session", cwd: "/tmp/zimlo-fixture" });
    expect(parsed.flatMap((value) => value.events).map((event) => event.kind)).toEqual([
      "session_started", "command_started", "tests_passed", "completed",
    ]);
    expect(parsed.at(-1)?.events[0]?.provenance).toBe("agent_reported");
  });

  it("tolerates truncated and unknown records", () => {
    const state: ParserState = { provider: "codex", providerSessionId: "fallback", toolCalls: new Map() };
    expect(parseCodexLine("{not-complete", state).events).toEqual([]);
    expect(parseCodexLine('{"type":"future_record","payload":{"x":1}}', state).events).toEqual([]);
  });

  it("captures user task input but skips injected runtime context", () => {
    const state: ParserState = { provider: "codex", providerSessionId: "fallback", toolCalls: new Map() };
    const task = parseCodexLine('{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"优化任务列表"}]}}', state);
    const context = parseCodexLine('{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>cwd=/tmp</environment_context>"}]}}', state);
    expect(task.events).toEqual([expect.objectContaining({ kind: "user_instruction", payload: { prompt: "优化任务列表" } })]);
    expect(context.events).toEqual([]);
  });

  it("does not treat write_stdin as a file mutation", () => {
    const state: ParserState = { provider: "codex", providerSessionId: "fallback", toolCalls: new Map() };
    const stdin = parseCodexLine('{"type":"response_item","payload":{"type":"function_call","name":"write_stdin","call_id":"a","arguments":"{\\"session_id\\":1,\\"chars\\":\\"y\\"}"}}', state);
    const patch = parseCodexLine('{"type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","call_id":"b","input":{"patch":"*** Begin Patch"}}}', state);
    expect(stdin.events.map((event) => event.kind)).toEqual([]);
    expect(patch.events).toEqual([expect.objectContaining({ kind: "files_changed" })]);
  });
});

describe("Claude Code 2.1.207 fixture contract", () => {
  it("pairs tool use/result and records a real failing exit", () => {
    const state: ParserState = { provider: "claude", providerSessionId: "fallback", toolCalls: new Map() };
    const parsed = fixture("claude-2.1.207.jsonl").map((line) => parseClaudeLine(line, state));
    expect(parsed[0]?.metadata).toMatchObject({ providerSessionId: "claude-fixture-session", cwd: "/tmp/zimlo-fixture" });
    expect(parsed.flatMap((value) => value.events).map((event) => event.kind)).toEqual([
      "session_started", "command_started", "tests_failed", "completed",
    ]);
    expect(parsed.at(-1)?.events[0]?.provenance).toBe("agent_reported");
  });

  it("captures a textual user task separately from tool results", () => {
    const state: ParserState = { provider: "claude", providerSessionId: "fallback", toolCalls: new Map() };
    const parsed = parseClaudeLine('{"type":"user","sessionId":"claude-a","message":{"content":[{"type":"text","text":"完成发布检查"}]}}', state);
    expect(parsed.events).toEqual([expect.objectContaining({ kind: "user_instruction", payload: { prompt: "完成发布检查" } })]);
  });
});

describe("redaction", () => {
  it("removes tokens, environment secrets and private keys before persistence", () => {
    const privateKey = "-----BEGIN PRIVATE KEY-----\nsecret-material\n-----END PRIVATE KEY-----";
    const value = redactText(`OPENAI_API_KEY=sk-proj_abcdefghijklmnop ${privateKey} Bearer abc.def.ghi`);
    expect(value).not.toContain("abcdefghijklmnop");
    expect(value).not.toContain("secret-material");
    expect(value).not.toContain("abc.def.ghi");
    expect(redactUnknown({ env: { SECRET: "value" }, message: "safe" })).toEqual({ env: "[REDACTED]", message: "safe" });
    expect(redactText("FEATURE_FLAG=enabled")).toBe("FEATURE_FLAG=[REDACTED]");
    expect(redactUnknown({ file_path: "/repo/.env.local", content: "HARMLESS_NAME=still-secret", pathHint: "kept" }))
      .toEqual({ file_path: "/repo/.env.local", content: "[REDACTED_ENV_FILE]", pathHint: "kept" });
  });
});

describe("process classification", () => {
  it("keeps real CLIs but rejects desktop helpers and marks app-server infrastructure", () => {
    expect(classifyAgentCommand("/opt/homebrew/bin/claude --resume c405ecb6-99cf-4c47-a1f1-dd795a6f70c9"))
      .toMatchObject({ provider: "claude", providerSessionId: "c405ecb6-99cf-4c47-a1f1-dd795a6f70c9", sessionBearing: true });
    expect(classifyAgentCommand("/Applications/ChatGPT.app/Contents/Resources/codex app-server --listen stdio://"))
      .toMatchObject({ provider: "codex", sessionBearing: false });
    expect(classifyAgentCommand("/Applications/ChatGPT.app/Contents/Resources/codex sandbox -- command"))
      .toMatchObject({ provider: "codex", sessionBearing: false });
    expect(classifyAgentCommand("/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Renderer)"))
      .toBeNull();
    expect(classifyAgentCommand("browser_crashpad_handler --database=/Users/me/Library/Application Support/Codex/Crashpad"))
      .toBeNull();
  });
});
