import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_CAPABILITIES, type Session } from "@zimlo/protocol";
import { ActionBroker } from "../src/action-broker.js";
import { RuntimeHub } from "../src/runtime.js";
import { ZimloStore } from "../src/store.js";

const temporaryDirectories: string[] = [];

function setup() {
  const directory = mkdtempSync(join(process.cwd(), ".zimlo-action-broker-"));
  temporaryDirectories.push(directory);
  const store = new ZimloStore(join(directory, "zimlo.db"));
  const runtime = new RuntimeHub(store);
  const now = new Date().toISOString();
  const project = store.ensureProjectForCwd(directory, now);
  const session: Session = {
    id: "session-a",
    projectId: project?.id,
    provider: "codex",
    surface: "cli",
    providerSessionId: "provider-a",
    title: "Test",
    cwd: directory,
    transcriptPath: null,
    status: "waiting",
    lastActivityAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    activePid: null,
    processStartedAt: null,
    tty: null,
    correlationUncertain: false,
    capabilities: EMPTY_CAPABILITIES,
  };
  store.upsertSession(session);
  return { store, runtime, project, broker: new ActionBroker(runtime) };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("ActionBroker", () => {
  it("matches the exact action, session and device, and resolves each waiter separately", async () => {
    const { store, broker } = setup();
    const first = broker.create({ sessionId: "session-a", kind: "approval", title: "A", detail: "A", availableDecisions: [{ id: "yes", label: "Yes", scope: "once", value: true, risk: "low" }] });
    const second = broker.create({ sessionId: "session-a", kind: "approval", title: "B", detail: "B", availableDecisions: [{ id: "no", label: "No", scope: "deny", value: false, risk: "low" }] });
    expect(broker.decide({ deviceId: "device-a", actionId: second.action.actionId, sessionId: "wrong", decisionId: "no", idempotencyKey: "wrong" }).ok).toBe(false);
    expect(broker.decide({ deviceId: "device-a", actionId: second.action.actionId, sessionId: "session-a", decisionId: "no", idempotencyKey: "second" }).ok).toBe(true);
    expect(broker.decide({ deviceId: "device-a", actionId: first.action.actionId, sessionId: "session-a", decisionId: "yes", idempotencyKey: "first" }).ok).toBe(true);
    expect((await first.result)?.decision.id).toBe("yes");
    expect((await second.result)?.decision.id).toBe("no");
    store.close();
  });

  it("returns the original result on device-scoped replay without resolving twice", async () => {
    const { store, runtime, broker } = setup();
    const results: unknown[] = [];
    runtime.onMessage((message) => {
      if (message.type === "action.result") results.push(message);
    });
    const pending = broker.create({ sessionId: "session-a", kind: "approval", title: "A", detail: "A", availableDecisions: [{ id: "yes", label: "Yes", scope: "once", value: true, risk: "low" }] });
    const submission = { deviceId: "device-a", actionId: pending.action.actionId, sessionId: "session-a", decisionId: "yes", idempotencyKey: "same" };
    expect(broker.decide(submission)).toEqual(broker.decide(submission));
    expect((await pending.result)?.decision.id).toBe("yes");
    expect(results).toHaveLength(2);
    store.close();
  });

  it("keeps pending approvals independent from editorial posts", async () => {
    const { store, runtime, broker } = setup();
    runtime.postFeed({
      id: "post-a",
      taskId: "task-a",
      runId: "provider-a",
      agentId: "codex",
      sessionId: "session-a",
      kind: "attention",
      presentation: { system: "swiss", theme: "safety_orange", layout: "alert", typography: "sans", density: "airy", mediaPlacement: "none" },
      headline: "需要批准操作",
      takeaway: "Agent 需要执行受保护的命令。",
      highlights: [],
      blocks: [],
      dedupeKey: "approval-a",
      source: "agent",
      createdAt: new Date().toISOString(),
    });
    const pending = broker.create({
      sessionId: "session-a",
      kind: "approval",
      title: "A",
      detail: "A",
      availableDecisions: [{ id: "yes", label: "Yes", scope: "once", value: true, risk: "low" }],
    });
    expect(store.listFeedPosts()[0]).toMatchObject({ id: "post-a", kind: "attention" });
    expect(broker.decide({ deviceId: "device-a", actionId: pending.action.actionId, sessionId: "session-a", decisionId: "yes", idempotencyKey: "resolve" }).ok).toBe(true);
    expect(store.listFeedPosts()[0]).toMatchObject({ id: "post-a", kind: "attention" });
    await pending.result;
    store.close();
  });

  it("caps the complete redacted event payload at 4 KB", () => {
    const { store, runtime } = setup();
    runtime.ingestEvent({
      id: "large-event",
      sequence: 0,
      provider: "codex",
      sessionId: "session-a",
      providerSessionId: "provider-a",
      kind: "command_completed",
      source: "hook",
      occurredAt: new Date().toISOString(),
      payload: { output: "密钥和值\\\n\"".repeat(5_000) },
      provenance: "verified",
    });
    const event = store.listEvents("session-a")[0];
    expect(Buffer.byteLength(JSON.stringify(event?.payload), "utf8")).toBeLessThanOrEqual(4_096);
    expect(event?.payload).toMatchObject({ truncated: true });
    store.close();
  });

  it("records safe automatic approvals in the timeline and audit without leaving a pending action", async () => {
    const { store, broker, project } = setup();
    expect(project).not.toBeNull();
    store.updateTrustPolicy(project!.id, "safe_automation", "local-admin");
    const automatic = broker.create({
      sessionId: "session-a",
      kind: "approval",
      title: "运行测试",
      detail: "pnpm test",
      approvalContext: {
        category: "test",
        projectId: project!.id,
        cwd: project!.primaryPath,
        command: "pnpm test",
        segments: ["pnpm test"],
        withinProject: true,
        reason: "识别为 test",
      },
      availableDecisions: [{ id: "once", label: "允许一次", scope: "once", value: true, risk: "low" }],
    });

    expect(automatic.action.state).toBe("resolved");
    expect((await automatic.result)?.decision.id).toBe("once");
    expect(store.listActions()).toHaveLength(1);
    expect(store.listActions()[0]?.state).toBe("resolved");
    expect(store.listTrustAudit(project!.id)[0]).toMatchObject({ category: "test", decision: "auto_allowed" });
    store.close();
  });
});
