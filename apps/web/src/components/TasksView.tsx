import { useMemo, useState } from "react";
import type { ClientCommand, FeedPost, Project, Session, TaskPreference, TaskRecord } from "@zimlo/protocol";
import { ProviderBadge } from "./ProviderBadge";
import { runtimeLabel, sessionLocation } from "./sessionPresentation";

interface TasksViewProps {
  projects: Project[];
  sessions: Session[];
  tasks: TaskRecord[];
  posts?: FeedPost[];
  preferences: TaskPreference[];
  send: (command: ClientCommand) => void;
  onOpen: (sessionId: string) => void;
}

type TaskFilter = "all" | "attention" | "active" | "ready";
const EMPTY_POSTS: FeedPost[] = [];

const FILTERS: Array<{ id: TaskFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "attention", label: "待我处理" },
  { id: "active", label: "进行中" },
  { id: "ready", label: "可继续" },
];

const STATE_LABELS: Record<string, string> = {
  running: "进行中",
  waiting: "等待中",
  waiting_input: "等你回复",
  reviewing: "检查中",
  user_review: "待你审阅",
  completed: "已完成",
  failed: "失败",
  idle: "可继续",
  ended: "已结束",
  unknown: "状态未知",
};

function latestTasksBySession(tasks: TaskRecord[]): Map<string, TaskRecord> {
  const latest = new Map<string, TaskRecord>();
  for (const task of tasks) {
    if (!task.sessionId) continue;
    const current = latest.get(task.sessionId);
    if (!current || task.updatedAt > current.updatedAt) latest.set(task.sessionId, task);
  }
  return latest;
}

function latestPostsBySession(posts: FeedPost[]): Map<string, FeedPost> {
  const latest = new Map<string, FeedPost>();
  for (const post of posts) {
    if (!post.sessionId) continue;
    const current = latest.get(post.sessionId);
    if (!current || post.createdAt > current.createdAt) latest.set(post.sessionId, post);
  }
  return latest;
}

export function collapseProcessSessions(sessions: Session[]): { sessions: Session[]; counts: Map<string, number> } {
  const representatives: Session[] = [];
  const representativeByGroup = new Map<string, string>();
  const counts = new Map<string, number>();
  const stableSessions = [...sessions].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  for (const session of stableSessions) {
    if (!session.providerSessionId.startsWith("process:")) {
      representatives.push(session);
      continue;
    }
    const group = `${session.provider}:${session.cwd ?? "unknown"}`;
    const representativeId = representativeByGroup.get(group);
    if (representativeId) {
      counts.set(representativeId, (counts.get(representativeId) ?? 1) + 1);
      continue;
    }
    representativeByGroup.set(group, session.id);
    counts.set(session.id, 1);
    representatives.push(session);
  }
  return { sessions: representatives, counts };
}

function effectiveState(session: Session, task: TaskRecord | undefined): string {
  if (session.correlationUncertain) return session.status;
  return task?.state ?? session.status;
}

export function taskTitle(session: Session, task: TaskRecord | undefined, post?: FeedPost): string {
  const generated = /^(?:Codex|Claude) · (?:活跃进程 \d+|[0-9a-f]{8}|[^·]+)$/iu.test(session.title);
  if (generated && !session.correlationUncertain && post?.headline) return post.headline;
  if (generated && !session.correlationUncertain && task?.reason && task.reason.length <= 100) return task.reason.replace(/。$/u, "");
  if (/^(?:Codex|Claude) · 活跃进程 \d+$/u.test(session.title)) {
    return `${runtimeLabel(session.provider)} 正在 ${sessionLocation(session).label} 工作`;
  }
  if (generated && /^[0-9a-f]{8}$/iu.test(session.title.split(" · ").at(-1) ?? "")) {
    return `${runtimeLabel(session.provider)} 任务 · ${sessionLocation(session).label}`;
  }
  return session.title;
}

function relativeTaskTime(value: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)} 天前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(value));
}

function statePriority(state: string): number {
  if (["waiting", "waiting_input", "user_review", "failed"].includes(state)) return 0;
  if (["running", "reviewing"].includes(state)) return 1;
  if (["idle", "completed"].includes(state)) return 2;
  return 3;
}

function isReadyTask(session: Session, state: string): boolean {
  if (statePriority(state) < 2) return false;
  return session.capabilities.resumable || session.capabilities.replyable || state === "idle";
}

function stateLabel(session: Session, state: string): string {
  if (state === "idle" && !session.capabilities.replyable) return "只读";
  if (state === "running" && session.activePid) return "终端中运行";
  return STATE_LABELS[state] ?? state;
}

function taskNextStep(session: Session, state: string): string | null {
  if (state === "waiting_input" || state === "waiting") return "需要你的回复";
  if (state === "user_review") return "结果已就绪，等待你审阅";
  if (state === "failed") return "执行失败，查看原因和恢复方式";
  if (state === "reviewing") return "Agent 正在检查结果";
  if (state === "running") return "Agent 正在执行";
  if (isReadyTask(session, state)) return "可以继续布置后续工作";
  return null;
}

export function TasksView({ projects, sessions, tasks, posts = EMPTY_POSTS, preferences, send, onOpen }: TasksViewProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [projectId, setProjectId] = useState<string>("all");
  const [showAll, setShowAll] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const taskBySession = useMemo(() => latestTasksBySession(tasks), [tasks]);
  const postBySession = useMemo(() => latestPostsBySession(posts), [posts]);
  const preferenceBySession = useMemo(() => new Map(preferences.map((preference) => [preference.sessionId, preference])), [preferences]);
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const stableProjects = useMemo(
    () => [...projects].sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt) || left.name.localeCompare(right.name, "zh-CN", { sensitivity: "base" })),
    [projects],
  );
  const collapsed = useMemo(() => collapseProcessSessions(sessions), [sessions]);
  const managedSessions = collapsed.sessions;
  const currentSessions = managedSessions.filter((session) => !preferenceBySession.get(session.id)?.archivedAt);
  const attentionCount = currentSessions.filter((session) => statePriority(effectiveState(session, taskBySession.get(session.id))) === 0).length;
  const activeCount = currentSessions.filter((session) => {
    const state = effectiveState(session, taskBySession.get(session.id));
    return statePriority(state) === 1;
  }).length;
  const readyCount = currentSessions.filter((session) => isReadyTask(session, effectiveState(session, taskBySession.get(session.id)))).length;

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = [...managedSessions]
    .filter((session) => {
      const task = taskBySession.get(session.id);
      const state = effectiveState(session, task);
      const preference = preferenceBySession.get(session.id);
      if (showArchived !== Boolean(preference?.archivedAt)) return false;
      if (projectId !== "all" && session.projectId !== projectId) return false;
      if (filter === "attention" && statePriority(state) !== 0) return false;
      if (filter === "active" && statePriority(state) !== 1) return false;
      if (filter === "ready" && !isReadyTask(session, state)) return false;
      if (!normalizedQuery) return true;
      const location = sessionLocation(session);
      return [taskTitle(session, task, postBySession.get(session.id)), task?.reason, projectById.get(session.projectId ?? "")?.name, location.label, session.cwd, runtimeLabel(session.provider), state]
        .some((value) => value?.toLocaleLowerCase().includes(normalizedQuery));
    })
    .sort((left, right) => {
      const pinned = Number(Boolean(preferenceBySession.get(right.id)?.pinnedAt)) - Number(Boolean(preferenceBySession.get(left.id)?.pinnedAt));
      if (pinned) return pinned;
      const priority = statePriority(effectiveState(left, taskBySession.get(left.id))) - statePriority(effectiveState(right, taskBySession.get(right.id)));
      return priority || right.lastActivityAt.localeCompare(left.lastActivityAt) || left.id.localeCompare(right.id);
    });
  const visible = normalizedQuery || showAll
    ? filtered
    : [
      ...filtered.filter((session) => statePriority(effectiveState(session, taskBySession.get(session.id))) === 0).slice(0, 4),
      ...filtered.filter((session) => statePriority(effectiveState(session, taskBySession.get(session.id))) === 1).slice(0, 6),
      ...filtered.filter((session) => statePriority(effectiveState(session, taskBySession.get(session.id))) >= 2).slice(0, 6),
    ];
  const groups = [
    { id: "pinned", label: "已置顶", hint: "重要任务", sessions: visible.filter((session) => preferenceBySession.get(session.id)?.pinnedAt) },
    { id: "attention", label: "待你处理", hint: "回复、审阅或恢复", sessions: visible.filter((session) => !preferenceBySession.get(session.id)?.pinnedAt && statePriority(effectiveState(session, taskBySession.get(session.id))) === 0) },
    { id: "active", label: "正在工作", hint: "Agent 正在推进", sessions: visible.filter((session) => !preferenceBySession.get(session.id)?.pinnedAt && statePriority(effectiveState(session, taskBySession.get(session.id))) === 1) },
    { id: "recent", label: showArchived ? "已归档" : "可继续与最近完成", hint: showArchived ? "不影响当前注意力" : "随时回看或继续", sessions: visible.filter((session) => !preferenceBySession.get(session.id)?.pinnedAt && statePriority(effectiveState(session, taskBySession.get(session.id))) >= 2) },
  ].filter((group) => group.sessions.length > 0);

  return (
    <section className="tasks-view">
      <div className="task-tools">
        <nav className="task-filters" aria-label="任务筛选">
          {FILTERS.map((item) => {
            const count = item.id === "all" ? currentSessions.length : item.id === "attention" ? attentionCount : item.id === "active" ? activeCount : readyCount;
            return (
              <button key={item.id} className={filter === item.id ? "active" : ""} onClick={() => { setFilter(item.id); setShowArchived(false); setShowAll(false); }}>
                {item.label}<span>{count}</span>
              </button>
            );
          })}
          <button className={showArchived ? "active" : ""} onClick={() => { setShowArchived((value) => !value); setFilter("all"); setShowAll(true); }}>{showArchived ? "返回任务" : "已归档"}</button>
          <details className="directory-search">
            <summary aria-label="搜索和项目筛选">⌕</summary>
            <div className="directory-search-panel">
              <label className="task-search">
                <span aria-hidden="true">⌕</span>
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务或目录" aria-label="搜索任务" />
                {query && <button onClick={() => setQuery("")} aria-label="清空搜索">×</button>}
              </label>
              <label className="task-project-select">
                <span>项目</span>
                <select value={projectId} onChange={(event) => { setProjectId(event.target.value); setShowAll(false); }} aria-label="按项目筛选任务">
                  <option value="all">全部项目 · {currentSessions.length}</option>
                  {stableProjects.filter((project) => project.sessionCount > 0).map((project) => (
                    <option value={project.id} key={project.id}>{project.name} · {project.sessionCount}</option>
                  ))}
                </select>
              </label>
            </div>
          </details>
        </nav>
      </div>

      {groups.map((group) => (
        <section className={`task-group task-group-${group.id}`} key={group.id}>
          <header>
            <div><h3>{group.label}</h3><span>{group.hint}</span></div>
            <strong>{group.sessions.length}</strong>
          </header>
          <div className="task-list">
            {group.sessions.map((session) => {
              const task = taskBySession.get(session.id);
              const state = effectiveState(session, task);
              const location = sessionLocation(session);
              const processCount = collapsed.counts.get(session.id) ?? 1;
              const tone = statePriority(state) === 0 ? "attention" : statePriority(state) === 1 ? "active" : session.status;
              const nextStep = taskNextStep(session, state);
              return (
                <article className={`task-row task-row-${statePriority(state) === 0 ? "attention" : statePriority(state) === 1 ? "active" : "settled"}`} key={session.id}>
                  <button className="task-row-main" onClick={() => onOpen(session.id)}>
                    <span className="task-provider-mark">
                      <ProviderBadge provider={session.provider} surface={session.surface} labelMode="icon" />
                    </span>
                    <span className="task-copy">
                      <strong>{processCount > 1 ? `${runtimeLabel(session.provider)} 在 ${location.label} 运行 ${processCount} 个任务` : taskTitle(session, task, postBySession.get(session.id))}</strong>
                      <small>{location.kind === "project" ? "项目" : "目录"} · {location.label}<span aria-hidden="true"> · </span>{processCount > 1 ? `${processCount} 个活跃进程已归组` : relativeTaskTime(session.lastActivityAt)}</small>
                      {nextStep && <span className="task-next-step">{nextStep}</span>}
                    </span>
                    <span className="task-side">
                      <span className={`task-state-pill task-state-${tone}`}>{stateLabel(session, state)}</span>
                    </span>
                  </button>
                  <details className="task-row-menu">
                    <summary aria-label="管理任务">•••</summary>
                    <div>
                      <button
                        className={preferenceBySession.get(session.id)?.pinnedAt ? "active" : ""}
                        onClick={() => send({ type: "task.pin", sessionId: session.id, pinned: !preferenceBySession.get(session.id)?.pinnedAt })}
                      >{preferenceBySession.get(session.id)?.pinnedAt ? "取消置顶" : "置顶任务"}</button>
                      <button
                        onClick={() => send({ type: "task.archive", sessionId: session.id, archived: !preferenceBySession.get(session.id)?.archivedAt })}
                      >{preferenceBySession.get(session.id)?.archivedAt ? "恢复任务" : "归档任务"}</button>
                    </div>
                  </details>
                </article>
              );
            })}
          </div>
        </section>
      ))}

      {filtered.length === 0 && (
        <div className="task-empty"><strong>没有找到任务</strong><p>试试项目名、任务关键词或切换筛选。</p></div>
      )}
      {!normalizedQuery && filtered.length > visible.length && (
        <button className="show-all-tasks" onClick={() => setShowAll(true)}>显示其余 {filtered.length - visible.length} 个任务</button>
      )}
    </section>
  );
}
