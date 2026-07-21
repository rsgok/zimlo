import { describe, expect, it } from "vitest";
import { commandApprovalDecisions, fileApprovalDecisions } from "../src/codex-app-server.js";

describe("Codex app-server approval mapping", () => {
  it("keeps the provider decision values and requires confirmation for session scope", () => {
    const decisions = commandApprovalDecisions({
      command: "pnpm test",
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
    });

    expect(decisions.map((decision) => decision.value)).toEqual(["accept", "acceptForSession", "decline", "cancel"]);
    expect(decisions.find((decision) => decision.scope === "session")?.confirmationPhrase).toBe("本次会话允许");
    expect(decisions.some((decision) => decision.scope === "persistent")).toBe(false);
  });

  it("only exposes a persistent execpolicy choice when upstream proposes the exact amendment", () => {
    const decisions = commandApprovalDecisions({
      command: "git status",
      proposedExecpolicyAmendment: ["git", "status"],
    });
    const persistent = decisions.find((decision) => decision.scope === "persistent");

    expect(persistent?.value).toEqual({
      acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "status"] },
    });
    expect(persistent?.confirmationPhrase).toBe("永久允许");
  });

  it("uses only the documented file-change decisions", () => {
    expect(fileApprovalDecisions().map((decision) => decision.value)).toEqual([
      "accept",
      "acceptForSession",
      "decline",
      "cancel",
    ]);
  });
});
