import { describe, expect, it } from "vitest";
import { userInstructionText } from "../src/user-instruction";

describe("userInstructionText", () => {
  it("extracts real Codex and Claude user messages", () => {
    expect(userInstructionText([{ type: "input_text", text: "修复登录问题" }])).toBe("修复登录问题");
    expect(userInstructionText([{ type: "text", text: "优化任务列表" }])).toBe("优化任务列表");
  });

  it("ignores runtime context and tool results", () => {
    expect(userInstructionText([{ type: "input_text", text: "<environment_context>cwd=/tmp</environment_context>" }])).toBe("");
    expect(userInstructionText([{ type: "tool_result", content: "secret output" }])).toBe("");
  });
});
