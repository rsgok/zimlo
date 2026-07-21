import { useState } from "react";
import type { ClientCommand, PendingAction } from "@zimlo/protocol";

interface ActionPanelProps {
  action: PendingAction;
  send: (command: ClientCommand) => void;
}

export function ActionPanel({ action, send }: ActionPanelProps) {
  const [answer, setAnswer] = useState("");
  const [confirmations, setConfirmations] = useState<Record<string, string>>({});

  if (action.kind === "input") {
    return (
      <section className="action-panel" aria-label="等待输入">
        <p className="action-detail">{action.detail}</p>
        <label className="field-label" htmlFor={`answer-${action.actionId}`}>回复 Agent</label>
        <textarea
          id={`answer-${action.actionId}`}
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          placeholder="输入你的回答…"
          rows={3}
        />
        <button
          className="primary-button"
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
      </section>
    );
  }

  return (
    <section className="action-panel" aria-label="等待审批">
      <p className="action-detail">{action.detail}</p>
      <div className="decision-list">
        {action.availableDecisions.map((decision) => (
          <div className="decision" key={decision.id}>
            {decision.confirmationPhrase && (
              <label className="confirm-field">
                <span>输入「{decision.confirmationPhrase}」确认</span>
                <input
                  value={confirmations[decision.id] ?? ""}
                  onChange={(event) => setConfirmations((current) => ({ ...current, [decision.id]: event.target.value }))}
                  autoComplete="off"
                />
              </label>
            )}
            <button
              className={decision.scope === "deny" ? "secondary-button" : "primary-button"}
              disabled={Boolean(decision.confirmationPhrase && confirmations[decision.id] !== decision.confirmationPhrase)}
              onClick={() => send({
                type: "action.decide",
                actionId: action.actionId,
                sessionId: action.sessionId,
                decisionId: decision.id,
                idempotencyKey: crypto.randomUUID(),
                ...(decision.confirmationPhrase ? { confirmationPhrase: confirmations[decision.id] ?? "" } : {}),
              })}
            >{decision.label}</button>
          </div>
        ))}
      </div>
    </section>
  );
}
