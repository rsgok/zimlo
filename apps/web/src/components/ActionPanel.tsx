import { useEffect, useState } from "react";
import type { ClientCommand, Decision, PendingAction } from "@zimlo/protocol";
import { FormattedText } from "./FormattedText";
import { VoiceInput } from "./VoiceInput";

interface ActionPanelProps {
  action: PendingAction;
  send: (command: ClientCommand) => boolean;
  compact?: boolean;
}

const RISK_LABELS: Record<Decision["risk"], string> = {
  high: "高风险",
  medium: "中风险",
  low: "低风险",
};

const SCOPE_LABELS: Record<Decision["scope"], string> = {
  once: "仅本次",
  session: "本次任务内",
  persistent: "长期有效",
  deny: "拒绝",
  input: "提交输入",
};

export function ActionPanel({ action, send, compact = false }: ActionPanelProps) {
  const draftKey = `zimlo:action-draft:${action.actionId}`;
  const [answer, setAnswer] = useState(() => typeof localStorage === "undefined" ? "" : localStorage.getItem(draftKey) ?? "");
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<Decision | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const hasLongDetail = compact && action.detail.length > 140;

  useEffect(() => {
    if (answer) localStorage.setItem(draftKey, answer);
    else localStorage.removeItem(draftKey);
  }, [answer, draftKey]);

  // 审批过期后清空确认短语与选中态，避免把过期意图发出去。
  useEffect(() => {
    const remaining = new Date(action.expiresAt).getTime() - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      setSelected(null);
      setConfirmation("");
      return;
    }
    const timer = window.setTimeout(() => {
      setSelected(null);
      setConfirmation("");
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [action.expiresAt]);

  const decide = (decision: Decision, confirmationPhrase?: string) => {
    const accepted = send({
      type: "action.decide",
      actionId: action.actionId,
      sessionId: action.sessionId,
      decisionId: decision.id,
      idempotencyKey: crypto.randomUUID(),
      ...(confirmationPhrase ? { confirmationPhrase } : {}),
    });
    if (!accepted) return;
    localStorage.removeItem(draftKey);
    setSubmitted(true);
  };

  return (
    <section className="action-panel" aria-label={action.kind === "input" ? "等待输入" : "等待审批"}>
      <div className="action-heading">
        <strong>{action.kind === "input" ? "直接回复 Agent" : "直接处理审批"}</strong>
        <span>{new Date(action.expiresAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 前有效</span>
      </div>
      <div className={`action-detail ${!compact ? "action-detail-full" : expanded ? "action-detail-expanded" : ""}`}><FormattedText text={action.detail} compact /></div>
      {hasLongDetail && (
        <button className="action-expand" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "收起详情" : "展开详情"}
        </button>
      )}

      {submitted ? (
        <p className="action-sync-state">已保存在本机，等待 Agent 确认</p>
      ) : action.kind === "input" ? (
        <div className="action-input-row">
          <VoiceInput compact ariaLabel="回复 Agent" value={answer} onChange={setAnswer} placeholder="说出或输入回答…" rows={1} />
          <button
            className="action-submit"
            disabled={!answer.trim()}
            onClick={() => {
              const accepted = send({
                type: "action.decide",
                actionId: action.actionId,
                sessionId: action.sessionId,
                decisionId: "submit-input",
                idempotencyKey: crypto.randomUUID(),
                input: { answer: answer.trim() },
              });
              if (!accepted) return;
              localStorage.removeItem(draftKey);
              setSubmitted(true);
            }}
          >提交回复</button>
        </div>
      ) : selected?.confirmationPhrase ? (
        <form
          className="action-confirm"
          onSubmit={(event) => {
            event.preventDefault();
            if (confirmation === selected.confirmationPhrase) decide(selected, confirmation);
          }}
        >
          <dl className="action-confirm-facts">
            <div><dt>风险</dt><dd className={selected.risk === "high" ? "action-risk-high" : ""}>{RISK_LABELS[selected.risk]}</dd></div>
            <div><dt>作用域</dt><dd>{SCOPE_LABELS[selected.scope]}</dd></div>
          </dl>
          <label>
            <span>输入「{selected.confirmationPhrase}」确认{selected.label}</span>
            <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" autoFocus />
          </label>
          <div className="action-confirm-buttons">
            <button type="button" className="action-choice action-choice-secondary" onClick={() => { setSelected(null); setConfirmation(""); }}>返回</button>
            <button type="button" className="action-choice action-choice-secondary" onClick={() => setConfirmation(selected.confirmationPhrase ?? "")}>填入确认短语</button>
            <button
              type="submit"
              className="action-choice action-choice-primary"
              disabled={confirmation !== selected.confirmationPhrase}
            >确认{selected.label}</button>
          </div>
        </form>
      ) : (
        <div className="decision-list">
          {action.availableDecisions.map((decision) => (
            <button
              className={`action-choice ${decision.scope === "deny" ? "action-choice-secondary" : "action-choice-primary"}`}
              key={decision.id}
              onClick={() => decision.confirmationPhrase ? setSelected(decision) : decide(decision)}
            >{decision.label}</button>
          ))}
        </div>
      )}
    </section>
  );
}
