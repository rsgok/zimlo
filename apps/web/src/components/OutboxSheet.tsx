import { useEffect, useRef } from "react";
import type { ClientCommand, Session, TrustedWorkspace } from "@zimlo/protocol";
import { isOutboxEntryCancelable, isOutboxEntryDiscardable, isOutboxEntryEditable, type CommandOutboxEntry } from "../lib/commandOutbox";
import { relativeTime, useNow } from "../lib/nowTicker";
import { useModalFocus } from "./useModalFocus";

interface OutboxSheetProps {
  entries: CommandOutboxEntry[];
  sessions: Session[];
  workspaces: TrustedWorkspace[];
  onCancelEntry: (entryId: string) => void;
  onRetryEntry: (entryId: string) => void;
  onReeditEntry: (entryId: string) => void;
  onRemoveEntry: (entryId: string) => void;
  onClose: () => void;
}

const STATE_LABELS: Record<NonNullable<CommandOutboxEntry["state"]>, string> = {
  queued: "排队中 · 未发送",
  sent: "已发送 · 待确认",
  failed: "被 Bridge 拒绝",
};

function sessionTitle(sessions: Session[], sessionId: string | null | undefined): string | null {
  if (!sessionId) return null;
  return sessions.find((session) => session.id === sessionId)?.title ?? `任务 ${sessionId.slice(0, 8)}…`;
}

function workspaceLabel(workspaces: TrustedWorkspace[], workspaceId: string | null | undefined): string | null {
  if (!workspaceId) return null;
  return workspaces.find((workspace) => workspace.id === workspaceId)?.label ?? null;
}

// 面板行展示：操作类型、目标（任务/会话/项目）、内容预览。纯函数便于测试。
export function describeOutboxCommand(
  command: ClientCommand,
  sessions: Session[],
  workspaces: TrustedWorkspace[],
): { typeLabel: string; target: string | null; preview: string } {
  switch (command.type) {
    case "task.create":
      return { typeLabel: "新任务", target: workspaceLabel(workspaces, command.workspaceId) ?? "可信目录", preview: command.text };
    case "task.follow_up":
      return { typeLabel: "追加指令", target: sessionTitle(sessions, command.sessionId), preview: command.text };
    case "session.message":
      return { typeLabel: "会话消息", target: sessionTitle(sessions, command.sessionId), preview: command.text };
    case "task.command.retry":
      return { typeLabel: "重试指令", target: null, preview: `指令 ${command.commandId.slice(0, 8)}…` };
    case "task.command.cancel":
      return { typeLabel: "撤回指令", target: null, preview: `指令 ${(command.commandId ?? command.idempotencyKey ?? "").slice(0, 8)}…` };
    case "action.decide":
      return { typeLabel: "审批决定", target: sessionTitle(sessions, command.sessionId), preview: `决定 ${command.decisionId}` };
    case "feed.dismiss":
    case "feed.dismiss.set":
      return { typeLabel: command.type === "feed.dismiss.set" && !command.dismissed ? "恢复 Feed 卡片" : "移出 Feed", target: null, preview: command.itemId };
    case "task.pin":
      return { typeLabel: command.pinned ? "置顶任务" : "取消置顶", target: sessionTitle(sessions, command.sessionId), preview: "" };
    case "task.archive":
      return { typeLabel: command.archived ? "归档任务" : "恢复任务", target: sessionTitle(sessions, command.sessionId), preview: "" };
    case "user.profile.update":
      return { typeLabel: "更新头像", target: null, preview: command.avatarId };
    case "agent.profile.update":
      return { typeLabel: "更新 Agent 资料", target: null, preview: command.displayName };
    case "trust.policy.update":
      return { typeLabel: "自动化权限", target: null, preview: command.preset === "safe_automation" ? "安全自动化" : "总是询问" };
    case "notification.settings.update":
      return { typeLabel: "通知设置", target: null, preview: command.settings.enabled ? "开启通知" : "关闭通知" };
    case "notification.device.register":
      return { typeLabel: "注册推送设备", target: null, preview: "" };
    case "notification.device.unregister":
      return { typeLabel: "注销推送设备", target: null, preview: "" };
    default:
      return { typeLabel: command.type, target: null, preview: "" };
  }
}

// 把失败条目的文本恢复到对应草稿，交给用户重新编辑。
export function restoreDraftForEntry(entry: CommandOutboxEntry): boolean {
  if (typeof localStorage === "undefined") return false;
  const command = entry.command;
  if (command.type === "task.create") {
    localStorage.setItem("zimlo:new-task-draft", command.text);
    return true;
  }
  if (command.type === "task.follow_up" || command.type === "session.message") {
    localStorage.setItem(`zimlo:task-draft:${command.sessionId}`, command.text);
    return true;
  }
  return false;
}

export function OutboxSheet({ entries, sessions, workspaces, onCancelEntry, onRetryEntry, onReeditEntry, onRemoveEntry, onClose }: OutboxSheetProps) {
  const now = useNow();
  const sheetRef = useRef<HTMLElement>(null);
  useModalFocus(sheetRef);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const sorted = [...entries].sort((left, right) => right.enqueuedAt.localeCompare(left.enqueuedAt));

  return (
    <div className="composer-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <section className="outbox-sheet" role="dialog" aria-modal="true" aria-labelledby="outbox-title" ref={sheetRef}>
        <header className="outbox-header">
          <div>
            <h2 id="outbox-title">本机指令队列</h2>
            <p>发送前会持久化在本机；重连后按原幂等键自动重放，不会重复执行。</p>
          </div>
          <button onClick={onClose} aria-label="关闭指令队列">×</button>
        </header>
        {sorted.length === 0 ? (
          <p className="outbox-empty">队列是空的。离线时发出的指令会先出现在这里。</p>
        ) : (
          <ul className="outbox-list">
            {sorted.map((entry) => {
              const description = describeOutboxCommand(entry.command, sessions, workspaces);
              const state = entry.state ?? "queued";
              return (
                <li className={`outbox-entry outbox-entry-${state}`} key={entry.id}>
                  <div className="outbox-entry-main">
                    <div className="outbox-entry-topline">
                      <strong>{description.typeLabel}</strong>
                      {description.target && <span>{description.target}</span>}
                      <time>{relativeTime(entry.enqueuedAt, now)}</time>
                    </div>
                    {description.preview && <p className="outbox-entry-preview">{description.preview}</p>}
                    <div className="outbox-entry-state">
                      <span className={`outbox-state-pill outbox-state-${state}`}>{STATE_LABELS[state]}</span>
                      {state === "failed" && entry.error && <span className="outbox-entry-error">{entry.error}</span>}
                    </div>
                  </div>
                  <div className="outbox-entry-actions">
                    {isOutboxEntryCancelable(entry) && (
                      <button type="button" className="text-button" onClick={() => onCancelEntry(entry.id)}>撤回</button>
                    )}
                    {isOutboxEntryEditable(entry) && (
                      <>
                        <button type="button" className="text-button" onClick={() => onRetryEntry(entry.id)}>重试</button>
                        <button type="button" className="text-button" onClick={() => onReeditEntry(entry.id)}>重新编辑</button>
                      </>
                    )}
                    {isOutboxEntryDiscardable(entry) && (
                      <button type="button" className="text-button" onClick={() => onRemoveEntry(entry.id)}>移除</button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
