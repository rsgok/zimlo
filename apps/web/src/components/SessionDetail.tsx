import { useEffect, useMemo, useState } from "react";
import type { ClientCommand, FeedPost, PendingAction, Project, Session, TaskCommand, TaskRecord, UnifiedEvent } from "@zimlo/protocol";
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
  task?: TaskRecord | undefined;
  timelineCursor?: string | undefined;
  send: (command: ClientCommand) => boolean;
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

const STATUS_LABELS: Record<string, string> = {
  running: "进行中",
  waiting: "等待中",
  idle: "可继续",
  completed: "已完成",
  failed: "失败",
  ended: "已结束",
  unknown: "状态未知",
  waiting_input: "等你回复",
  reviewing: "检查中",
  user_review: "待你审阅",
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

export function conciseInstruction(value: string, maxLength = 420): string {
  return conciseTaskInput(cleanDisplayText(value), maxLength);
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

function eventCoveredByAgentPost(event: UnifiedEvent, posts: FeedPost[]): boolean {
  if (!(event.kind === "completed" || event.kind === "failed")) return false;
  const matchingKinds = event.kind === "completed" ? new Set<FeedPost["kind"]>(["result"]) : new Set<FeedPost["kind"]>(["failure"]);
  const occurredAt = new Date(event.occurredAt).getTime();
  return posts.some((post) => matchingKinds.has(post.kind) && Math.abs(new Date(post.createdAt).getTime() - occurredAt) <= 15 * 60 * 1_000);
}

type TimelineItem =
  | { type: "post"; id: string; at: string; post: FeedPost; details: UnifiedEvent[]; aliases: string[] }
  | { type: "command"; id: string; at: string; command: TaskCommand; details: UnifiedEvent[]; aliases: string[] }
  | { type: "turn"; id: string; at: string; instruction: UnifiedEvent | null; event: UnifiedEvent; details: UnifiedEvent[]; aliases: string[] };

function groupEventsByTurn(events: UnifiedEvent[]): UnifiedEvent[][] {
  const groups = new Map<string, UnifiedEvent[]>();
  let legacyTurn = 0;
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence || left.occurredAt.localeCompare(right.occurredAt))) {
    if (!event.turnId && event.kind === "user_instruction") legacyTurn += 1;
    const key = event.turnId ? `provider:${event.turnId}` : `legacy:${legacyTurn}`;
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function eventDistance(left: string, right: string): number {
  return Math.abs(new Date(left).getTime() - new Date(right).getTime());
}

export function buildTaskTimeline(posts: FeedPost[], commands: TaskCommand[], events: UnifiedEvent[]): TimelineItem[] {
  const filteredEvents = events
    .filter((event) => EVENT_LABELS[event.kind])
    .filter((event) => !eventCoveredByAgentPost(event, posts))
    .filter((event) => event.kind !== "completed" || readablePayload(event.payload));
  const timeline: TimelineItem[] = [
    ...posts.map((post): TimelineItem => ({
      type: "post",
      id: post.id,
      at: post.createdAt,
      post,
      details: [],
      aliases: [`post:${post.id}`],
    })),
    ...commands.map((command): TimelineItem => ({
      type: "command",
      id: command.id,
      at: command.createdAt,
      command,
      details: [],
      aliases: [`command:${command.id}`],
    })),
  ];

  for (const group of groupEventsByTurn(filteredEvents)) {
    const instruction = group.find((event) => event.kind === "user_instruction") ?? null;
    const matchingCommand = instruction
      ? timeline
        .filter((item): item is Extract<TimelineItem, { type: "command" }> => item.type === "command" && item.command.text.trim() === instructionText(instruction).trim())
        .sort((left, right) => eventDistance(left.at, instruction.occurredAt) - eventDistance(right.at, instruction.occurredAt))[0]
      : undefined;
    const supportingEvents = group.filter((event) => event !== instruction);

    if (matchingCommand) {
      matchingCommand.details.push(...supportingEvents);
      matchingCommand.aliases.push(...group.map((event) => `event:${event.id}`));
      continue;
    }

    if (instruction) {
      const latest = group.at(-1) ?? instruction;
      timeline.push({
        type: "turn",
        id: instruction.turnId ?? instruction.id,
        at: instruction.occurredAt,
        instruction,
        event: latest,
        details: supportingEvents,
        aliases: [`turn:${instruction.turnId ?? instruction.id}`, ...group.map((event) => `event:${event.id}`)],
      });
      continue;
    }

    const latest = group.at(-1);
    if (!latest) continue;
    const nearestPrimary = [...timeline]
      .sort((left, right) => eventDistance(left.at, latest.occurredAt) - eventDistance(right.at, latest.occurredAt))[0];
    if (nearestPrimary && eventDistance(nearestPrimary.at, latest.occurredAt) <= 6 * 60 * 60 * 1_000) {
      nearestPrimary.details.push(...group);
      nearestPrimary.aliases.push(...group.map((event) => `event:${event.id}`));
      continue;
    }
    timeline.push({
      type: "turn",
      id: latest.turnId ?? latest.id,
      at: latest.occurredAt,
      instruction: null,
      event: latest,
      details: group.filter((event) => event.id !== latest.id),
      aliases: [`turn:${latest.turnId ?? latest.id}`, ...group.map((event) => `event:${event.id}`)],
    });
  }

  return timeline.sort((left, right) => right.at.localeCompare(left.at));
}

function TimelineEventDetails({ events }: { events: UnifiedEvent[] }) {
  if (events.length === 0) return null;
  return (
    <div className="timeline-detail-list">
      {events.map((event) => {
        const summary = event.kind === "user_instruction" ? conciseInstruction(instructionText(event), 360) : readablePayload(event.payload);
        const diff = event.kind === "files_changed" && event.source !== "process" ? attributedDiff(event.payload) : "";
        const failed = ["tests_failed", "failed", "blocked"].includes(event.kind);
        return (
          <div className={`timeline-detail-row ${failed ? "is-failure" : ""}`} data-timeline-level="secondary" key={event.id}>
            <div className="timeline-detail-meta"><strong>{EVENT_LABELS[event.kind]}</strong><time>{readableDate(event.occurredAt)}</time></div>
            {summary && <FormattedText text={summary.length > 360 ? `${summary.slice(0, 360)}…` : summary} compact />}
            {diff && <details className="timeline-diff"><summary>查看任务 Diff</summary><pre>{diff}</pre></details>}
          </div>
        );
      })}
    </div>
  );
}

export function SessionDetail({ session, project, events, actions, posts, commands, task, timelineCursor, send, onClose }: SessionDetailProps) {
  const draftKey = `zimlo:task-draft:${session.id}`;
  const [message, setMessage] = useState(() => typeof localStorage === "undefined" ? "" : localStorage.getItem(draftKey) ?? "");
  const instructions = [...events]
    .filter((event) => event.kind === "user_instruction")
    .sort((left, right) => left.sequence - right.sequence);
  const firstInstruction = instructions[0];
  const rawTaskInput = cleanDisplayText(firstInstruction ? instructionText(firstInstruction) || session.title : session.title);
  const taskInput = conciseTaskInput(rawTaskInput, 220);
  const location = sessionLocation(session);
  const pendingAction = actions.find((action) => action.state === "pending");
  const pendingActions = actions.filter((action) => action.state === "pending");
  const queuedCommand = commands.find((command) => ["queued", "dispatching", "running"].includes(command.state));
  const currentState = task?.state ?? session.status;
  const latestActionPrompt = [...posts].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .find((post) => post.actionPrompt && (post.pendingActionIds.some((id) => pendingActions.some((action) => action.actionId === id)) || (post.pendingActionIds.length === 0 && ["waiting_input", "user_review"].includes(currentState))))?.actionPrompt;
  const nextAction = pendingAction?.title
    ?? (queuedCommand ? COMMAND_LABELS[queuedCommand.state] : null)
    ?? latestActionPrompt
    ?? (currentState === "waiting_input"
      ? "回复 Agent，让任务继续"
      : currentState === "user_review"
        ? "审阅最新结果；需要调整时直接追加指令"
        : currentState === "reviewing"
          ? "Agent 正在检查结果，无需操作"
          : currentState === "running"
            ? "Agent 正在执行，无需操作"
            : currentState === "failed"
              ? "查看失败原因并决定是否重试"
              : "可以继续布置任务");
  const canContinue = Boolean(session.cwd && !session.correlationUncertain);
  const willQueue = session.activePid !== null || ["running", "waiting", "reviewing"].includes(currentState);
  const activeQueue = commands.filter((command) => ["queued", "dispatching", "running"].includes(command.state)).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const duplicateActive = activeQueue.some((command) => command.text.trim() === message.trim());
  const latestPost = [...posts].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];

  const timeline = useMemo(() => buildTaskTimeline(posts, commands, events), [commands, events, posts]);
  const timelineIds = timeline.map((item) => `${item.type}:${item.id}`);
  const cursorIndex = timelineCursor ? timeline.findIndex((item) => item.aliases.includes(timelineCursor)) : -1;
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
          <div><strong id="detail-title">{project?.agentProfile.displayName ?? session.title}</strong><small>{timeline.length} 条关键动态</small></div>
        </header>

        <section className="task-profile-header">
          <div className="task-profile-identity">
            <div className={`task-runtime-avatar ${project ? agentAvatarStyle(project.id) : `provider-${session.provider}`}`} aria-hidden="true">{project?.agentProfile.avatar ?? (session.provider === "codex" ? "C" : "CC")}</div>
            <div>
              <strong>{project?.agentProfile.displayName ?? (session.provider === "codex" ? "Codex" : "Claude Code")}</strong>
              <span>{sessionRuntimeLabel(session)} · {location.label}</span>
            </div>
            <span className={`task-status task-status-${currentState}`}>{STATUS_LABELS[currentState] ?? currentState}</span>
          </div>
          <div className="task-profile-copy">
            <p className="task-profile-label">Task Input</p>
            <div className="task-input"><FormattedText text={taskInput} compact /></div>
            {rawTaskInput.trim() !== taskInput.trim() && <details className="task-input-full"><summary>查看完整输入</summary><FormattedText text={rawTaskInput} /></details>}
          </div>
          <div className="task-profile-summary">
            {latestPost && <div className="task-latest-result"><span>最新结论</span><strong>{latestPost.headline}</strong></div>}
            <div className="task-next-action"><span>现在需要你</span><strong>{nextAction}</strong></div>
          </div>
          <div className="task-profile-meta" aria-label="任务信息">
            <span>{location.kind === "project" ? "项目" : "目录"} · {location.label}</span>
            <span>开始于 {readableDate(session.createdAt)}</span>
          </div>
          {session.correlationUncertain && <p className="task-profile-note">当前任务关联仍待确认，因此保持只读，避免把指令发到其他 Session。</p>}
          {pendingActions.length > 0 && (
            <section className="profile-attention-panel" aria-label="当前待处理事项">
              <p className="eyebrow">待处理</p>
              {pendingActions.map((action) => <ActionPanel key={action.actionId} action={action} send={send} />)}
            </section>
          )}
        </section>

        <section className="task-timeline" aria-label="任务 Timeline">
          <header className="timeline-heading"><h2>动态</h2><span>{unreadCount > 0 ? `${unreadCount} 条未读 · 已定位` : "关键轮次在第一层"}</span></header>
          {timeline.map((item) => {
            if (item.type === "post") {
              const detailCount = item.details.length + item.post.highlights.length + (item.post.proof ? 1 : 0) + (item.post.actionPrompt ? 1 : 0);
              return (
              <article className={`task-timeline-item timeline-${item.post.kind}`} data-timeline-level="primary" key={`post:${item.id}`}>
                <div className={`timeline-avatar ${project ? agentAvatarStyle(project.id) : `provider-${session.provider}`}`} aria-hidden="true">{project?.agentProfile.avatar ?? "A"}</div>
                <div className="timeline-content">
                  <div className="timeline-meta"><strong>{project?.agentProfile.displayName ?? item.post.agentId.toUpperCase()}</strong><span>{POST_LABELS[item.post.kind]}</span><time>· {readableDate(item.at)}</time></div>
                  <h3>{item.post.headline}</h3><FormattedText text={item.post.takeaway} />
                  {detailCount > 0 && <details className="timeline-thread">
                    <summary>查看 {detailCount} 项执行细节</summary>
                    <div className="timeline-thread-panel">
                      {item.post.highlights.length > 0 && <ul>{item.post.highlights.map((highlight) => <li key={highlight}>{highlight}</li>)}</ul>}
                      {item.post.proof && <p className="timeline-proof"><span>已验证</span>{item.post.proof}</p>}
                      {item.post.actionPrompt && <p className="timeline-action-prompt">{item.post.actionPrompt}</p>}
                      <TimelineEventDetails events={item.details} />
                    </div>
                  </details>}
                </div>
              </article>
              );
            }
            if (item.type === "command") return (
              <article className={`task-timeline-item timeline-command timeline-command-${item.command.state}`} data-timeline-level="primary" key={`command:${item.id}`}>
                <div className="timeline-avatar timeline-avatar-user" aria-hidden="true">你</div>
                <div className="timeline-content">
                  <div className="timeline-meta"><strong>你</strong><span>{item.command.kind === "create" ? "创建任务" : "追加指令"}</span><time>· {readableDate(item.at)}</time></div>
                  <div className="timeline-command-text"><FormattedText text={conciseInstruction(item.command.text)} /></div><span className="timeline-state-pill">{COMMAND_LABELS[item.command.state]}</span>
                  {item.command.error && <div className="timeline-command-error"><FormattedText text={item.command.error} compact /></div>}
                  {item.command.state === "failed" && <button className="timeline-retry" onClick={() => send({ type: "task.command.retry", commandId: item.command.id, idempotencyKey: crypto.randomUUID() })}>重试</button>}
                  {item.details.length > 0 && <details className="timeline-thread"><summary>查看 {item.details.length} 项执行细节</summary><div className="timeline-thread-panel"><TimelineEventDetails events={item.details} /></div></details>}
                </div>
              </article>
            );
            const summary = item.instruction ? conciseInstruction(instructionText(item.instruction)) : readablePayload(item.event.payload);
            const failedEvent = item.details.find((event) => ["tests_failed", "failed", "blocked"].includes(event.kind));
            return (
              <article className={`task-timeline-item timeline-${failedEvent || ["tests_failed", "failed", "blocked"].includes(item.event.kind) ? "failure" : "progress"}`} data-timeline-level="primary" key={`turn:${item.id}`}>
                <div className={`timeline-avatar ${item.instruction ? "timeline-avatar-user" : "timeline-avatar-agent"}`} aria-hidden="true">{item.instruction ? "你" : "A"}</div>
                <div className="timeline-content">
                  <div className="timeline-meta"><strong>{item.instruction ? "你" : "Agent"}</strong><span>{item.instruction ? "本轮指令" : EVENT_LABELS[item.event.kind]}</span><time>· {readableDate(item.at)}</time></div>
                  {summary && <div className="timeline-turn-summary"><FormattedText text={summary.length > 420 ? `${summary.slice(0, 420)}…` : summary} /></div>}
                  {failedEvent && <p className="timeline-turn-alert">{EVENT_LABELS[failedEvent.kind]} · {readablePayload(failedEvent.payload) || "本轮需要进一步处理"}</p>}
                  {item.details.length > 0 && <details className="timeline-thread"><summary>查看本轮 {item.details.length} 项执行细节</summary><div className="timeline-thread-panel"><TimelineEventDetails events={item.details} /></div></details>}
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
