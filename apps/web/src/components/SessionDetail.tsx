import { useEffect, useState } from "react";
import type { ClientCommand, FeedPost, PendingAction, Session, UnifiedEvent } from "@zimlo/protocol";
import { ActionPanel } from "./ActionPanel";
import { conciseTaskInput, runtimeLabel, sessionLocation } from "./sessionPresentation";

interface SessionDetailProps {
  session: Session;
  events: UnifiedEvent[];
  actions: PendingAction[];
  posts: FeedPost[];
  send: (command: ClientCommand) => void;
  onClose: () => void;
}

const POST_LABELS: Record<FeedPost["kind"], string> = {
  progress: "阶段成果",
  decision: "新的判断",
  attention: "需要关注",
  result: "结果",
  failure: "失败 / 风险",
};

const EVENT_LABELS: Partial<Record<UnifiedEvent["kind"], string>> = {
  plan_updated: "计划已更新",
  tests_passed: "验证通过",
  tests_failed: "验证失败",
  blocked: "任务受阻",
  completed: "本轮完成",
  failed: "执行失败",
};

const STATUS_LABELS: Record<Session["status"], string> = {
  running: "进行中",
  waiting: "等待中",
  idle: "可继续",
  completed: "已完成",
  failed: "失败",
  ended: "已结束",
  unknown: "状态未知",
};

function instructionText(event: UnifiedEvent): string {
  if (typeof event.payload === "string") return event.payload;
  if (!event.payload || typeof event.payload !== "object") return "";
  const payload = event.payload as Record<string, unknown>;
  for (const key of ["prompt", "instruction", "message", "text"]) {
    if (typeof payload[key] === "string") return payload[key];
  }
  return "";
}

function readableDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function eventReadableText(payload: unknown): string {
  if (typeof payload === "string") return payload.slice(0, 500);
  if (Array.isArray(payload)) {
    return payload.map(eventReadableText).filter(Boolean).join(" ").slice(0, 500);
  }
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  for (const key of ["summary", "message", "reason", "text", "content", "command"]) {
    const text = eventReadableText(record[key]);
    if (text) return text;
  }
  return "";
}

export function SessionDetail({ session, events, actions, posts, send, onClose }: SessionDetailProps) {
  const [composerOpen, setComposerOpen] = useState(false);
  const [message, setMessage] = useState("");
  const instructions = [...events]
    .filter((event) => event.kind === "user_instruction")
    .sort((left, right) => left.sequence - right.sequence);
  const firstInstruction = instructions[0];
  const rawTaskInput = firstInstruction ? instructionText(firstInstruction) || session.title : session.title;
  const taskInput = conciseTaskInput(rawTaskInput);
  const location = sessionLocation(session);
  const actionById = new Map(actions.map((action) => [action.actionId, action]));
  const linkedActionIds = new Set(posts.flatMap((post) => post.pendingActionIds));
  const unlinkedActions = actions.filter((action) => !linkedActionIds.has(action.actionId));
  const sortedPosts = [...posts].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const seenFallbacks = new Set<string>();
  const fallbackEvents = sortedPosts.length === 0 ? [...events]
    .filter((event) => EVENT_LABELS[event.kind])
    .filter((event) => event.kind !== "completed" || eventReadableText(event.payload))
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
    .filter((event) => {
      const key = `${event.kind}:${eventReadableText(event.payload)}`;
      if (seenFallbacks.has(key)) return false;
      seenFallbacks.add(key);
      return true;
    }) : [];
  const timelineCount = sortedPosts.length + unlinkedActions.length + fallbackEvents.length;
  const sessionStatusLabel = session.capabilities.replyable
    ? "可继续"
    : session.activePid ? "终端中运行" : session.correlationUncertain ? "只读" : STATUS_LABELS[session.status];

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="detail-backdrop" role="presentation">
      <section className="detail-panel" role="dialog" aria-modal="true" aria-labelledby="detail-title">
        <header className="detail-nav">
          <button className="detail-back-button" onClick={onClose} aria-label="返回 Feed">←</button>
          <div>
            <strong id="detail-title">{session.title}</strong>
            <small>{timelineCount} 条动态</small>
          </div>
        </header>

        <section className="task-profile-header">
          <div className={`task-runtime-avatar provider-${session.provider}`} aria-hidden="true">
            {session.provider === "codex" ? "C" : "CC"}
          </div>
          <div className="task-profile-copy">
            <p className="eyebrow">Task Input</p>
            <p className="task-input">{taskInput}</p>
            {rawTaskInput.trim() !== taskInput.trim() && (
              <details className="task-input-full">
                <summary>查看完整输入</summary>
                <pre>{rawTaskInput}</pre>
              </details>
            )}
          </div>
          <div className="task-profile-meta" aria-label="任务信息">
            <span className={`provider provider-${session.provider}`}>{runtimeLabel(session.provider)}</span>
            <span>{location.kind === "project" ? "项目" : "目录"} · {location.label}</span>
            <span className={`task-status task-status-${session.status}`}>{sessionStatusLabel}</span>
            <span>开始 · {readableDate(session.createdAt)}</span>
          </div>
          <div className="task-profile-actions">
            <button
              className="task-continue-button"
              disabled={!session.capabilities.replyable}
              onClick={() => setComposerOpen((open) => !open)}
            >{session.capabilities.replyable ? (composerOpen ? "收起" : "继续任务") : session.activePid ? "正在终端运行" : "当前只读"}</button>
          </div>
          {composerOpen && session.capabilities.replyable && (
            <section className="task-composer" aria-label="继续当前任务">
              <textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={3} placeholder="告诉 Agent 接下来做什么…" />
              <button
                disabled={!message.trim()}
                onClick={() => {
                  send({ type: "session.message", sessionId: session.id, text: message.trim(), idempotencyKey: crypto.randomUUID() });
                  setMessage("");
                  setComposerOpen(false);
                }}
              >发送并继续</button>
            </section>
          )}
          {session.correlationUncertain && (
            <p className="task-profile-note">当前进程与任务记录的关联仍待确认，因此部分操作保持只读。</p>
          )}
        </section>

        <section className="task-timeline" aria-label="任务 Timeline">
          <header className="timeline-heading">
            <h2>Timeline</h2>
            <span>只显示需要你阅读的信息</span>
          </header>

          {unlinkedActions.map((action) => (
            <article className="task-timeline-item timeline-attention" key={action.actionId}>
              <div className="timeline-marker" aria-hidden="true" />
              <div className="timeline-content">
                <div className="timeline-meta"><strong>需要你处理</strong><time>{readableDate(action.createdAt)}</time></div>
                <ActionPanel action={action} send={send} />
              </div>
            </article>
          ))}

          {sortedPosts.map((post) => {
            const linkedActions = post.pendingActionIds.flatMap((id) => actionById.get(id) ?? []);
            return (
              <article className={`task-timeline-item timeline-${post.kind}`} key={post.id}>
                <div className="timeline-marker" aria-hidden="true" />
                <div className="timeline-content">
                  <div className="timeline-meta">
                    <strong>{POST_LABELS[post.kind]} · {post.agentId.toUpperCase()}</strong>
                    <time>{readableDate(post.createdAt)}</time>
                  </div>
                  <h3>{post.headline}</h3>
                  <p>{post.takeaway}</p>
                  {post.highlights.length > 0 && (
                    <ul>{post.highlights.map((highlight) => <li key={highlight}>{highlight}</li>)}</ul>
                  )}
                  {post.proof && <p className="timeline-proof"><span>已验证</span>{post.proof}</p>}
                  {post.actionPrompt && <p className="timeline-action-prompt">{post.actionPrompt}</p>}
                  {linkedActions.map((action) => <ActionPanel key={action.actionId} action={action} send={send} />)}
                </div>
              </article>
            );
          })}

          {fallbackEvents.map((event) => {
            const summary = eventReadableText(event.payload);
            const preview = summary.length > 320 ? `${summary.slice(0, 320).trimEnd()}…` : summary;
            return (
              <article className={`task-timeline-item timeline-${event.kind === "tests_failed" || event.kind === "failed" || event.kind === "blocked" ? "failure" : "progress"}`} key={event.id}>
                <div className="timeline-marker" aria-hidden="true" />
                <div className="timeline-content">
                  <div className="timeline-meta">
                    <strong>{EVENT_LABELS[event.kind]}</strong>
                    <time>{readableDate(event.occurredAt)}</time>
                  </div>
                  {summary && <p className="timeline-fallback-summary">{preview}</p>}
                  {summary.length > 320 && (
                    <details className="timeline-more"><summary>展开完整更新</summary><p>{summary}</p></details>
                  )}
                </div>
              </article>
            );
          })}

          {sortedPosts.length === 0 && unlinkedActions.length === 0 && fallbackEvents.length === 0 && (
            <div className="timeline-empty">
              <strong>还没有需要阅读的更新</strong>
              <p>Agent 的工具调用和普通执行日志不会出现在这里。</p>
            </div>
          )}
        </section>
      </section>
    </div>
  );
}
