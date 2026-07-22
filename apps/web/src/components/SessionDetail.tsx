import { useEffect, useMemo, useState } from "react";
import type { ClientCommand, FeedPost, PendingAction, Project, Session, TaskCommand, UnifiedEvent } from "@zimlo/protocol";
import { ActionPanel } from "./ActionPanel";
import { FormattedText } from "./FormattedText";
import { VoiceInput } from "./VoiceInput";
import { agentAvatarStyle } from "./AgentsView";
import { conciseTaskInput, sessionLocation, sessionRuntimeLabel } from "./sessionPresentation";

interface SessionDetailProps {
  session: Session;
  project?: Project | undefined;
  events: UnifiedEvent[];
  actions: PendingAction[];
  posts: FeedPost[];
  commands: TaskCommand[];
  timelineCursor?: string | undefined;
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
  user_instruction: "你布置了任务",
  plan_updated: "计划已更新",
  files_changed: "文件发生变更",
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

const COMMAND_LABELS: Record<TaskCommand["state"], string> = {
  queued: "等待当前步骤结束",
  dispatching: "正在准备",
  running: "Agent 正在执行",
  completed: "已完成",
  failed: "发送失败",
  canceled: "已取消",
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

function cleanDisplayText(value: string): string {
  return value
    .replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/gu, "")
    .replace(/<response-annotations>[\s\S]*?<\/response-annotations>/gu, "")
    .replace(/::(?:git-[\w-]+|created-thread)\{[^\n]*\}/gu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function readablePayload(payload: unknown): string {
  if (typeof payload === "string") return cleanDisplayText(payload).slice(0, 800);
  if (Array.isArray(payload)) return payload.map(readablePayload).filter(Boolean).join(" ").slice(0, 800);
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  for (const key of ["summary", "message", "reason", "text", "content", "file_path", "path"]) {
    const value = readablePayload(record[key]);
    if (value) return value;
  }
  return "";
}

function attributedDiff(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  if (Array.isArray(payload)) return payload.map(attributedDiff).filter(Boolean).join("\n").slice(0, 12_000);
  const record = payload as Record<string, unknown>;
  for (const key of ["diff", "patch", "changes"]) {
    const value = record[key];
    if (typeof value === "string") return value.slice(0, 12_000);
    if (value && typeof value === "object") return JSON.stringify(value, null, 2).slice(0, 12_000);
  }
  for (const value of Object.values(record)) {
    const nested = attributedDiff(value);
    if (nested) return nested;
  }
  return "";
}

type TimelineItem =
  | { type: "post"; id: string; at: string; post: FeedPost }
  | { type: "event"; id: string; at: string; event: UnifiedEvent }
  | { type: "command"; id: string; at: string; command: TaskCommand };

export function SessionDetail({ session, project, events, actions, posts, commands, timelineCursor, send, onClose }: SessionDetailProps) {
  const draftKey = `zimlo:task-draft:${session.id}`;
  const [message, setMessage] = useState(() => typeof localStorage === "undefined" ? "" : localStorage.getItem(draftKey) ?? "");
  const instructions = [...events]
    .filter((event) => event.kind === "user_instruction")
    .sort((left, right) => left.sequence - right.sequence);
  const firstInstruction = instructions[0];
  const rawTaskInput = cleanDisplayText(firstInstruction ? instructionText(firstInstruction) || session.title : session.title);
  const taskInput = conciseTaskInput(rawTaskInput);
  const location = sessionLocation(session);
  const pendingAction = actions.find((action) => action.state === "pending");
  const pendingActions = actions.filter((action) => action.state === "pending");
  const queuedCommand = commands.find((command) => ["queued", "dispatching", "running"].includes(command.state));
  const latestActionPrompt = [...posts].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).find((post) => post.actionPrompt)?.actionPrompt;
  const nextAction = pendingAction?.title
    ?? (queuedCommand ? COMMAND_LABELS[queuedCommand.state] : null)
    ?? latestActionPrompt
    ?? (session.status === "running" ? "Agent 正在执行，无需操作" : session.status === "failed" ? "查看失败原因并决定是否重试" : "可以继续布置任务");
  const canContinue = Boolean(session.cwd && !session.correlationUncertain);
  const willQueue = session.activePid !== null || session.status === "running" || session.status === "waiting";
  const activeQueue = commands.filter((command) => ["queued", "dispatching", "running"].includes(command.state)).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const duplicateActive = activeQueue.some((command) => command.text.trim() === message.trim());
  const latestPost = [...posts].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];

  const timeline = useMemo<TimelineItem[]>(() => [
    ...posts.map((post): TimelineItem => ({ type: "post", id: post.id, at: post.createdAt, post })),
    ...commands.map((command): TimelineItem => ({ type: "command", id: command.id, at: command.createdAt, command })),
    ...events
      .filter((event) => EVENT_LABELS[event.kind])
      .filter((event) => event.kind !== "user_instruction" || !commands.some((command) => command.text === instructionText(event)))
      .filter((event) => event.kind !== "completed" || readablePayload(event.payload))
      .map((event): TimelineItem => ({ type: "event", id: event.id, at: event.occurredAt, event })),
  ].sort((left, right) => right.at.localeCompare(left.at)), [commands, events, posts]);
  const timelineIds = timeline.map((item) => `${item.type}:${item.id}`);
  const cursorIndex = timelineCursor ? timelineIds.indexOf(timelineCursor) : -1;
  const unreadCount = timeline.length === 0 || timelineCursor === timelineIds[0] ? 0 : cursorIndex >= 0 ? cursorIndex : timeline.length;

  useEffect(() => {
    const latest = timelineIds[0];
    if (!latest || latest === timelineCursor) return;
    const timer = window.setTimeout(() => send({ type: "task.timeline.seen", sessionId: session.id, itemId: latest }), 1_000);
    return () => window.clearTimeout(timer);
  }, [send, session.id, timelineCursor, timelineIds[0]]);

  useEffect(() => {
    if (message) localStorage.setItem(draftKey, message);
    else localStorage.removeItem(draftKey);
  }, [draftKey, message]);

  useEffect(() => {
    if (message && commands.some((command) => command.state === "completed" && command.text.trim() === message.trim())) setMessage("");
  }, [commands, message]);

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
          <div><strong id="detail-title">{session.title}</strong><small>Task Detail · {timeline.length} 条动态</small></div>
        </header>

        <section className="task-profile-header">
          <div className={`task-runtime-avatar ${project ? agentAvatarStyle(project.id) : `provider-${session.provider}`}`} aria-hidden="true">{project?.agentProfile.avatar ?? (session.provider === "codex" ? "C" : "CC")}</div>
          <div className="task-profile-copy">
            <p className="eyebrow">Task Input</p>
            <div className="task-input"><FormattedText text={taskInput} compact /></div>
            {rawTaskInput.trim() !== taskInput.trim() && <details className="task-input-full"><summary>查看完整输入</summary><FormattedText text={rawTaskInput} /></details>}
          </div>
          <div className="task-profile-meta" aria-label="任务信息">
            <span className={`provider provider-${session.provider}`}>{sessionRuntimeLabel(session)}</span>
            <span>{location.kind === "project" ? "项目" : "目录"} · {location.label}</span>
            <span className={`task-status task-status-${session.status}`}>{STATUS_LABELS[session.status]}</span>
            <span>开始 · {readableDate(session.createdAt)}</span>
          </div>
          <div className="task-next-action"><span>现在需要你</span><strong>{nextAction}</strong></div>
          {latestPost && <div className="task-latest-result"><span>最新结论</span><strong>{latestPost.headline}</strong><FormattedText text={latestPost.takeaway} compact /></div>}
          {session.correlationUncertain && <p className="task-profile-note">当前任务关联仍待确认，因此保持只读，避免把指令发到其他 Session。</p>}
          {pendingActions.length > 0 && (
            <section className="profile-attention-panel" aria-label="当前待处理事项">
              <p className="eyebrow">待处理</p>
              {pendingActions.map((action) => <ActionPanel key={action.actionId} action={action} send={send} />)}
            </section>
          )}
        </section>

        <section className="task-timeline" aria-label="任务 Timeline">
          <header className="timeline-heading"><h2>Timeline</h2><span>{unreadCount > 0 ? `${unreadCount} 条未读 · 已定位` : "最新动态在上"}</span></header>
          {timeline.map((item) => {
            if (item.type === "post") return (
              <article className={`task-timeline-item timeline-${item.post.kind}`} key={`post:${item.id}`}>
                <div className="timeline-marker" aria-hidden="true" />
                <div className="timeline-content">
                  <div className="timeline-meta"><strong>{POST_LABELS[item.post.kind]} · {item.post.agentId.toUpperCase()}</strong><time>{readableDate(item.at)}</time></div>
                  <h3>{item.post.headline}</h3><FormattedText text={item.post.takeaway} />
                  {item.post.highlights.length > 0 && <ul>{item.post.highlights.map((highlight) => <li key={highlight}>{highlight}</li>)}</ul>}
                  {item.post.proof && <p className="timeline-proof"><span>已验证</span>{item.post.proof}</p>}
                  {item.post.actionPrompt && <p className="timeline-action-prompt">{item.post.actionPrompt}</p>}
                </div>
              </article>
            );
            if (item.type === "command") return (
              <article className={`task-timeline-item timeline-command timeline-command-${item.command.state}`} key={`command:${item.id}`}>
                <div className="timeline-marker" aria-hidden="true" />
                <div className="timeline-content">
                  <div className="timeline-meta"><strong>{item.command.kind === "create" ? "你创建了任务" : "你追加了指令"}</strong><time>{readableDate(item.at)}</time></div>
                  <FormattedText text={item.command.text} /><span className="timeline-state-pill">{COMMAND_LABELS[item.command.state]}</span>
                  {item.command.error && <div className="timeline-command-error"><FormattedText text={item.command.error} compact /></div>}
                  {item.command.state === "failed" && <button className="timeline-retry" onClick={() => send({ type: "task.command.retry", commandId: item.command.id, idempotencyKey: crypto.randomUUID() })}>重试</button>}
                </div>
              </article>
            );
            const summary = item.event.kind === "user_instruction" ? instructionText(item.event) : readablePayload(item.event.payload);
            const diff = item.event.kind === "files_changed" && item.event.source !== "process" ? attributedDiff(item.event.payload) : "";
            return (
              <article className={`task-timeline-item timeline-${["tests_failed", "failed", "blocked"].includes(item.event.kind) ? "failure" : "progress"}`} key={`event:${item.id}`}>
                <div className="timeline-marker" aria-hidden="true" />
                <div className="timeline-content">
                  <div className="timeline-meta"><strong>{EVENT_LABELS[item.event.kind]}</strong><time>{readableDate(item.at)}</time></div>
                  {summary && <FormattedText text={summary.length > 800 ? `${summary.slice(0, 800)}…` : summary} />}
                  {diff && <details className="timeline-diff"><summary>查看任务 Diff</summary><pre>{diff}</pre></details>}
                </div>
              </article>
            );
          })}
          {timeline.length === 0 && <div className="timeline-empty"><strong>还没有需要阅读的更新</strong><p>Agent 的工具调用和普通执行日志不会出现在这里。</p></div>}
        </section>

        <section className="profile-composer" aria-label="继续当前任务">
          <VoiceInput compact value={message} onChange={setMessage} rows={1} ariaLabel="继续当前任务" placeholder={willQueue ? "说出或输入追加指令…" : "说出或输入下一步…"} disabled={!canContinue} />
          {activeQueue.length > 0 && <small className="queue-position">当前有 {activeQueue.length} 条指令在执行或排队</small>}
          <button disabled={!canContinue || !message.trim() || duplicateActive} onClick={() => {
            send({ type: "task.follow_up", sessionId: session.id, text: message.trim(), idempotencyKey: crypto.randomUUID() });
          }}>{duplicateActive ? "已在队列" : willQueue ? "加入队列" : "发送"}</button>
        </section>
      </section>
    </div>
  );
}
