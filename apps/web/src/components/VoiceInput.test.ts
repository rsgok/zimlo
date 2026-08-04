import { describe, expect, it } from "vitest";
import { mergeSpeechTranscript } from "./VoiceInput";

describe("mergeSpeechTranscript", () => {
  it("treats an invisible whitespace-only draft as empty", () => {
    expect(mergeSpeechTranscript("   \n", "开始优化")).toBe("开始优化");
  });

  it("keeps a visible draft while replacing interim speech results", () => {
    expect(mergeSpeechTranscript("继续处理", "附件问题")).toBe("继续处理 附件问题");
  });
});
