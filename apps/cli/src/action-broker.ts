import type { ApprovalContext, Decision, PendingAction } from "@zimlo/protocol";
import { uuidV7 } from "@zimlo/adapters";
import { RuntimeHub } from "./runtime.js";
import { canAutoAllow } from "./trust-policy.js";

export interface DecisionSubmission {
  deviceId: string;
  actionId: string;
  sessionId: string;
  decisionId: string;
  idempotencyKey: string;
  confirmationPhrase?: string;
  input?: Record<string, string>;
}

export interface DecisionResolution {
  decision: Decision;
  input?: Record<string, string>;
}

interface Resolver {
  resolve: (value: DecisionResolution | null) => void;
  timer: NodeJS.Timeout;
}

export interface NewAction {
  sessionId: string;
  upstreamRequestId?: string;
  kind: PendingAction["kind"];
  title: string;
  detail: string;
  availableDecisions: Decision[];
  approvalContext?: ApprovalContext;
  timeoutMs?: number;
}

export class ActionBroker {
  private readonly runtime: RuntimeHub;
  private readonly resolvers = new Map<string, Resolver>();

  constructor(runtime: RuntimeHub) {
    this.runtime = runtime;
  }

  create(input: NewAction): { action: PendingAction; result: Promise<DecisionResolution | null> } {
    const now = new Date();
    const timeoutMs = input.timeoutMs ?? 8 * 60 * 1000;
    const action: PendingAction = {
      actionId: uuidV7(),
      sessionId: input.sessionId,
      ...(input.upstreamRequestId ? { upstreamRequestId: input.upstreamRequestId } : {}),
      kind: input.kind,
      title: input.title,
      detail: input.detail,
      availableDecisions: input.availableDecisions,
      expiresAt: new Date(now.getTime() + timeoutMs).toISOString(),
      state: "pending",
      createdAt: now.toISOString(),
      ...(input.approvalContext ? { approvalContext: input.approvalContext } : {}),
    };
    if (input.kind === "approval" && input.approvalContext?.projectId) {
      const policy = this.runtime.store.getTrustPolicy(input.approvalContext.projectId);
      const allow = input.availableDecisions.find((decision) => decision.scope === "once");
      if (allow && canAutoAllow(input.approvalContext, policy)) {
        const resolved: PendingAction = { ...action, state: "resolved", resolvedAt: now.toISOString() };
        this.runtime.store.upsertAction(action);
        this.runtime.send({ type: "action.upsert", action });
        this.runtime.resolveAction(resolved);
        this.runtime.store.insertTrustAudit({
          id: uuidV7(),
          projectId: input.approvalContext.projectId,
          sessionId: input.sessionId,
          deviceId: policy.updatedByDeviceId || "local-policy",
          category: input.approvalContext.category,
          decision: "auto_allowed",
          reason: `项目策略 ${policy.preset} 自动允许`,
          actionSummary: input.detail.slice(0, 500),
          createdAt: now.toISOString(),
        });
        return { action: resolved, result: Promise.resolve({ decision: allow }) };
      }
      this.runtime.store.insertTrustAudit({
        id: uuidV7(),
        projectId: input.approvalContext.projectId,
        sessionId: input.sessionId,
        deviceId: "system",
        category: input.approvalContext.category,
        decision: "asked",
        reason: input.approvalContext.reason,
        actionSummary: input.detail.slice(0, 500),
        createdAt: now.toISOString(),
      });
    }
    this.runtime.upsertAction(action);

    const result = new Promise<DecisionResolution | null>((resolve) => {
      const timer = setTimeout(() => {
        this.resolvers.delete(action.actionId);
        const expired: PendingAction = { ...action, state: "expired", resolvedAt: new Date().toISOString() };
        this.runtime.resolveAction(expired);
        resolve(null);
      }, timeoutMs);
      timer.unref();
      this.resolvers.set(action.actionId, { resolve, timer });
    });
    return { action, result };
  }

  decide(submission: DecisionSubmission): { ok: boolean; message: string } {
    const storageKey = `${submission.deviceId}:${submission.idempotencyKey}`;
    const prior = this.runtime.store.getIdempotentResult(storageKey);
    if (prior && typeof prior === "object") {
      const result = prior as { ok: boolean; message: string };
      this.runtime.send({ type: "action.result", actionId: submission.actionId, ...result });
      return result;
    }

    const action = this.runtime.store.getAction(submission.actionId);
    const resolver = this.resolvers.get(submission.actionId);
    if (!action || !resolver) return this.saveResult(submission, false, "请求已过期或 Bridge 已重启。", submission.actionId);
    if (action.sessionId !== submission.sessionId) return this.saveResult(submission, false, "Session 与审批请求不匹配。", action.actionId);
    if (action.state !== "pending") return this.saveResult(submission, false, "请求已经处理。", action.actionId);
    if (new Date(action.expiresAt).getTime() <= Date.now()) return this.saveResult(submission, false, "请求已过期。", action.actionId);

    const decision = action.availableDecisions.find((candidate) => candidate.id === submission.decisionId);
    if (!decision) return this.saveResult(submission, false, "上游不支持该决策。", action.actionId);
    if (decision.confirmationPhrase && decision.confirmationPhrase !== submission.confirmationPhrase) {
      return this.saveResult(submission, false, `请输入确认短语：${decision.confirmationPhrase}`, action.actionId);
    }

    clearTimeout(resolver.timer);
    this.resolvers.delete(action.actionId);
    const resolved: PendingAction = { ...action, state: "resolved", resolvedAt: new Date().toISOString() };
    this.runtime.resolveAction(resolved);
    resolver.resolve({ decision, ...(submission.input ? { input: submission.input } : {}) });
    return this.saveResult(submission, true, "决策已提交给原始请求。", action.actionId);
  }

  cancelAll(): void {
    for (const [actionId, resolver] of this.resolvers) {
      clearTimeout(resolver.timer);
      resolver.resolve(null);
      const action = this.runtime.store.getAction(actionId);
      if (action) this.runtime.resolveAction({ ...action, state: "expired", resolvedAt: new Date().toISOString() });
    }
    this.resolvers.clear();
  }

  expire(actionId: string): void {
    const resolver = this.resolvers.get(actionId);
    if (!resolver) return;
    clearTimeout(resolver.timer);
    this.resolvers.delete(actionId);
    resolver.resolve(null);
    const action = this.runtime.store.getAction(actionId);
    if (action) this.runtime.resolveAction({ ...action, state: "expired", resolvedAt: new Date().toISOString() });
  }

  private saveResult(
    submission: Pick<DecisionSubmission, "deviceId" | "idempotencyKey">,
    ok: boolean,
    message: string,
    actionId: string,
  ): { ok: boolean; message: string } {
    const result = { ok, message };
    this.runtime.store.saveIdempotentResult(`${submission.deviceId}:${submission.idempotencyKey}`, actionId, result);
    this.runtime.send({ type: "action.result", actionId, ok, message });
    return result;
  }
}
