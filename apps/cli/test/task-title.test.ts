import { describe, expect, it } from "vitest";
import { EMPTY_CAPABILITIES, type Session } from "@zimlo/protocol";
import { hasGeneratedSessionTitle, taskTitleFromInput, titleSessionFromInput } from "../src/task-title";

const session: Session = {
  id: "session-a",
  provider: "codex",
  providerSessionId: "019f8600-abcdef",
  title: "Codex · zimlo",
  cwd: "/Users/kai/Code/zimlo",
  transcriptPath: null,
  status: "idle",
  lastActivityAt: "2026-07-22T00:00:00.000Z",
  createdAt: "2026-07-22T00:00:00.000Z",
  activePid: null,
  processStartedAt: null,
  tty: null,
  correlationUncertain: false,
  capabilities: EMPTY_CAPABILITIES,
};

describe("task title", () => {
  it("turns the first task input into a concise semantic title", () => {
    expect(taskTitleFromInput("# 修复登录问题\n\n同时补充回归测试")).toBe("修复登录问题 同时补充回归测试");
    expect(titleSessionFromInput(session, "让 Tasks 一眼能看懂任务语义").title).toBe("让 Tasks 一眼能看懂任务语义");
    expect(taskTitleFromInput("# Diff comments:\nFile: report.pdf\nComment: 不认可重复收费\n## My request for Codex:\nHandle it"))
      .toBe("不认可重复收费");
  });

  it("recognizes generated titles without replacing authored titles", () => {
    expect(hasGeneratedSessionTitle(session)).toBe(true);
    expect(hasGeneratedSessionTitle({ ...session, title: "登录刷新竞态已修复" })).toBe(false);
    expect(titleSessionFromInput({ ...session, title: "登录刷新竞态已修复" }, "新输入").title).toBe("登录刷新竞态已修复");
  });
});
