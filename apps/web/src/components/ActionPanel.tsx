import { useState } from "react";
import type { ClientCommand, Decision, PendingAction } from "@zimlo/protocol";
import { FormattedText } from "./FormattedText";
import { VoiceInput } from "./VoiceInput";

interface ActionPanelProps {
  action: PendingAction;
  send: (command: ClientCommand) => void;
  compact?: boolean;
}

export function ActionPanel({ action, send, compact = false }: ActionPanelProps) {
  const [answer, setAnswer] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<Decision | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const hasLongDetail = compact && action.detail.length > 140;

  const decide = (decision: Decision, confirmationPhrase?: string) => send({
    type: "action.decide",
    actionId: action.actionId,
    sessionId: action.sessionId,
    decisionId: decision.id,
    idempotencyKey: crypto.randomUUID(),
    ...(confirmationPhrase ? { confirmationPhrase } : {}),
  });

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

      {action.kind === "input" ? (
        <div className="action-input-row">
          <VoiceInput compact ariaLabel="回复 Agent" value={answer} onChange={setAnswer} placeholder="说出或输入回答…" rows={1} />
          <button
            className="action-submit"
            disabled={!answer.trim()}
            onClick={() => send({
              type: "action.decide",
              actionId: action.actionId,
              sessionId: action.sessionId,
              decisionId: "submit-input",
              idempotencyKey: crypto.randomUUID(),
              input: { answer: answer.trim() },
            })}
          >提交回复</button>
        </div>
      ) : selected?.confirmationPhrase ? (
        <div className="action-confirm">
          <label>
            <span>输入「{selected.confirmationPhrase}」确认</span>
            <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" />
          </label>
          <div className="action-confirm-buttons">
            <button className="action-choice action-choice-secondary" onClick={() => { setSelected(null); setConfirmation(""); }}>返回</button>
            <button
              className="action-choice action-choice-primary"
              disabled={confirmation !== selected.confirmationPhrase}
              onClick={() => decide(selected, confirmation)}
            >确认{selected.label}</button>
          </div>
        </div>
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
