import { useEffect, useMemo, useState } from "react";
import type { ClientCommand, FeedPost, PendingAction, Session, TaskCommand, UnifiedEvent } from "@zimlo/protocol";
import { ActionPanel } from "./ActionPanel";
import { conciseTaskInput, runtimeLabel, sessionLocation } from "./sessionPresentation";

interface SessionDetailProps {
  session: Session;
  events: UnifiedEvent[];
  actions: PendingAction[];
  posts: FeedPost[];
  commands: TaskCommand[];
  initialSection?: "timeline" | "diff";
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

function readablePayload(payload: unknown): string {
  if (typeof payload === "string") return payload.slice(0, 800);
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
  | { type: "action"; id: string; at: string; action: PendingAction }
  | { type: "event"; id: string; at: string; event: UnifiedEvent }
  | { type: "command"; id: string; at: string; command: TaskCommand };

export function SessionDetail({ session, events, actions, posts, commands, initialSection = "timeline", send, onClose }: SessionDetailProps) {
  const [message, setMessage] = useState("");
  const instructions = [...events]
    .filter((event) => event.kind === "user_instruction")
    .sort((left, right) => left.sequence - right.sequence);
  const firstInstruction = instructions[0];
  const rawTaskInput = firstInstruction ? instructionText(firstInstruction) || session.title : session.title;
  const taskInput = conciseTaskInput(rawTaskInput);
  const location = sessionLocation(session);
  const pendingAction = actions.find((action) => action.state === "pending");
  const queuedCommand = commands.find((command) => ["queued", "dispatching", "running"].includes(command.state));
  const latestActionPrompt = [...posts].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).find((post) => post.actionPrompt)?.actionPrompt;
  const nextAction = pendingAction?.title
    ?? (queuedCommand ? COMMAND_LABELS[queuedCommand.state] : null)
    ?? latestActionPrompt
    ?? (session.status === "running" ? "Agent 正在执行，无需操作" : session.status === "failed" ? "查看失败原因并决定是否重试" : "可以继续布置任务");
  const canContinue = Boolean(session.cwd && !session.correlationUncertain);
  const willQueue = session.activePid !== null || session.status === "running" || session.status === "waiting";
  const reviewEvents = events.filter((event) => event.kind === "files_changed" || event.kind === "tests_passed" || event.kind === "tests_failed");

  const timeline = useMemo<TimelineItem[]>(() => [
    ...posts.map((post): TimelineItem => ({ type: "post", id: post.id, at: post.createdAt, post })),
    ...actions.map((action): TimelineItem => ({ type: "action", id: action.actionId, at: action.createdAt, action })),
    ...commands.map((command): TimelineItem => ({ type: "command", id: command.id, at: command.createdAt, command })),
    ...events
      .filter((event) => EVENT_LABELS[event.kind])
      .filter((event) => event.kind !== "user_instruction" || !commands.some((command) => command.text === instructionText(event)))
      .filter((event) => event.kind !== "completed" || readablePayload(event.payload))
      .map((event): TimelineItem => ({ type: "event", id: event.id, at: event.occurredAt, event })),
  ].sort((left, right) => right.at.localeCompare(left.at)), [actions, commands, events, posts]);

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
          <div><strong id="detail-title">{session.title}</strong><small>{timeline.length} 条动态</small></div>
        </header>

        <section className="task-profile-header">
          <div className={`task-runtime-avatar provider-${session.provider}`} aria-hidden="true">{session.provider === "codex" ? "C" : "CC"}</div>
          <div className="task-profile-copy">
            <p className="eyebrow">Task Input</p>
            <p className="task-input">{taskInput}</p>
            {rawTaskInput.trim() !== taskInput.trim() && <details className="task-input-full"><summary>查看完整输入</summary><pre>{rawTaskInput}</pre></details>}
          </div>
          <div className="task-profile-meta" aria-label="任务信息">
            <span className={`provider provider-${session.provider}`}>{runtimeLabel(session.provider)}</span>
            <span>{location.kind === "project" ? "项目" : "目录"} · {location.label}</span>
            <span className={`task-status task-status-${session.status}`}>{STATUS_LABELS[session.status]}</span>
            <span>开始 · {readableDate(session.createdAt)}</span>
          </div>
          <div className="task-next-action"><span>现在需要你</span><strong>{nextAction}</strong></div>
          {session.correlationUncertain && <p className="task-profile-note">当前任务关联仍待确认，因此保持只读，避免把指令发到其他 Session。</p>}
        </section>

        {initialSection === "diff" && (
          <section className="task-review-area" aria-label="任务 Diff 与 Review">
            <header><div><p className="eyebrow">TASK REVIEW</p><h2>Diff 与验证</h2></div><span>{reviewEvents.length} 条证据</span></header>
            {reviewEvents.length === 0 ? (
              <div className="timeline-empty"><strong>这个任务还没有可归属的 Diff</strong><p>只有明确关联到当前任务的文件变更与测试结果会显示在这里。</p></div>
            ) : reviewEvents.map((event) => {
              const diff = event.kind === "files_changed" && event.source !== "process" ? attributedDiff(event.payload) : "";
              return (
                <article key={`review:${event.id}`} className={`review-evidence review-${event.kind}`}>
                  <div><strong>{EVENT_LABELS[event.kind]}</strong><time>{readableDate(event.occurredAt)}</time></div>
                  {readablePayload(event.payload) && <p>{readablePayload(event.payload)}</p>}
                  {diff && <pre>{diff}</pre>}
                </article>
              );
            })}
          </section>
        )}

        <section className="task-timeline" aria-label="任务 Timeline">
          <header className="timeline-heading"><h2>Timeline</h2><span>最新动态在上</span></header>
          {timeline.map((item) => {
            if (item.type === "post") return (
              <article className={`task-timeline-item timeline-${item.post.kind}`} key={`post:${item.id}`}>
                <div className="timeline-marker" aria-hidden="true" />
                <div className="timeline-content">
                  <div className="timeline-meta"><strong>{POST_LABELS[item.post.kind]} · {item.post.agentId.toUpperCase()}</strong><time>{readableDate(item.at)}</time></div>
                  <h3>{item.post.headline}</h3><p>{item.post.takeaway}</p>
                  {item.post.highlights.length > 0 && <ul>{item.post.highlights.map((highlight) => <li key={highlight}>{highlight}</li>)}</ul>}
                  {item.post.proof && <p className="timeline-proof"><span>已验证</span>{item.post.proof}</p>}
                  {item.post.actionPrompt && <p className="timeline-action-prompt">{item.post.actionPrompt}</p>}
                </div>
              </article>
            );
            if (item.type === "action") return (
              <article className={`task-timeline-item timeline-${item.action.state === "pending" ? "attention" : "resolved"}`} key={`action:${item.id}`}>
                <div className="timeline-marker" aria-hidden="true" />
                <div className="timeline-content">
                  <div className="timeline-meta"><strong>{item.action.state === "pending" ? "需要你处理" : "操作已处理"}</strong><time>{readableDate(item.at)}</time></div>
                  {item.action.state === "pending" ? <ActionPanel action={item.action} send={send} /> : <><h3>{item.action.title}</h3><p>{item.action.detail}</p><span className="timeline-state-pill">{item.action.state === "resolved" ? "已完成" : "已过期"}</span></>}
                </div>
              </article>
            );
            if (item.type === "command") return (
              <article className={`task-timeline-item timeline-command timeline-command-${item.command.state}`} key={`command:${item.id}`}>
                <div className="timeline-marker" aria-hidden="true" />
                <div className="timeline-content">
                  <div className="timeline-meta"><strong>{item.command.kind === "create" ? "你创建了任务" : "你追加了指令"}</strong><time>{readableDate(item.at)}</time></div>
                  <p>{item.command.text}</p><span className="timeline-state-pill">{COMMAND_LABELS[item.command.state]}</span>
                  {item.command.error && <p className="timeline-command-error">{item.command.error}</p>}
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
                  {summary && <p>{summary.length > 800 ? `${summary.slice(0, 800)}…` : summary}</p>}
                  {diff && <details className="timeline-diff"><summary>查看任务 Diff</summary><pre>{diff}</pre></details>}
                </div>
              </article>
            );
          })}
          {timeline.length === 0 && <div className="timeline-empty"><strong>还没有需要阅读的更新</strong><p>Agent 的工具调用和普通执行日志不会出现在这里。</p></div>}
        </section>

        <section className="profile-composer" aria-label="继续当前任务">
          <textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={2} placeholder={willQueue ? "追加指令，将在当前步骤结束后执行…" : "告诉 Agent 接下来做什么…"} disabled={!canContinue} />
          <button disabled={!canContinue || !message.trim()} onClick={() => {
            send({ type: "task.follow_up", sessionId: session.id, text: message.trim(), idempotencyKey: crypto.randomUUID() });
            setMessage("");
          }}>{willQueue ? "加入队列" : "发送"}</button>
        </section>
      </section>
    </div>
  );
}
