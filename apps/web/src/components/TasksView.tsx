import { useMemo, useState } from "react";
import type { Project, Session, TaskRecord } from "@zimlo/protocol";
import { runtimeLabel, sessionLocation, sessionRuntimeLabel } from "./sessionPresentation";

interface TasksViewProps {
  projects: Project[];
  sessions: Session[];
  tasks: TaskRecord[];
  onOpen: (sessionId: string) => void;
}

type TaskFilter = "all" | "active" | "codex" | "claude";

const FILTERS: Array<{ id: TaskFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "active", label: "进行中" },
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude Code" },
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

export function taskTitle(session: Session, task: TaskRecord | undefined): string {
  const generated = /^(?:Codex|Claude) · (?:活跃进程 \d+|[0-9a-f]{8}|[^·]+)$/iu.test(session.title);
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

function stateLabel(session: Session, state: string): string {
  if (state === "idle" && !session.capabilities.replyable) return "只读";
  if (state === "running" && session.activePid) return "终端中运行";
  return STATE_LABELS[state] ?? state;
}

export function TasksView({ projects, sessions, tasks, onOpen }: TasksViewProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [projectId, setProjectId] = useState<string>("all");
  const [showAll, setShowAll] = useState(false);
  const taskBySession = useMemo(() => latestTasksBySession(tasks), [tasks]);
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const stableProjects = useMemo(
    () => [...projects].sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { sensitivity: "base" }) || left.id.localeCompare(right.id)),
    [projects],
  );
  const collapsed = useMemo(() => collapseProcessSessions(sessions), [sessions]);
  const managedSessions = collapsed.sessions;
  const groupedProcessCount = sessions.length - managedSessions.length;
  const activeCount = managedSessions.filter((session) => {
    const state = effectiveState(session, taskBySession.get(session.id));
    return ["running", "waiting", "waiting_input", "reviewing", "user_review"].includes(state);
  }).length;

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = [...managedSessions]
    .filter((session) => {
      const task = taskBySession.get(session.id);
      const state = effectiveState(session, task);
      if (projectId !== "all" && session.projectId !== projectId) return false;
      if (filter === "active" && !["running", "waiting", "waiting_input", "reviewing", "user_review"].includes(state)) return false;
      if ((filter === "codex" || filter === "claude") && session.provider !== filter) return false;
      if (!normalizedQuery) return true;
      const location = sessionLocation(session);
      return [taskTitle(session, task), task?.reason, projectById.get(session.projectId ?? "")?.name, location.label, session.cwd, runtimeLabel(session.provider), state]
        .some((value) => value?.toLocaleLowerCase().includes(normalizedQuery));
    })
    .sort((left, right) => {
      const priority = statePriority(effectiveState(left, taskBySession.get(left.id))) - statePriority(effectiveState(right, taskBySession.get(right.id)));
      return priority || right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id);
    });
  const visible = normalizedQuery || showAll
    ? filtered
    : [
      ...filtered.filter((session) => statePriority(effectiveState(session, taskBySession.get(session.id))) === 0).slice(0, 4),
      ...filtered.filter((session) => statePriority(effectiveState(session, taskBySession.get(session.id))) === 1).slice(0, 6),
      ...filtered.filter((session) => statePriority(effectiveState(session, taskBySession.get(session.id))) >= 2).slice(0, 6),
    ];
  const groups = [
    { id: "attention", label: "需要关注", sessions: visible.filter((session) => statePriority(effectiveState(session, taskBySession.get(session.id))) === 0) },
    { id: "active", label: "进行中", sessions: visible.filter((session) => statePriority(effectiveState(session, taskBySession.get(session.id))) === 1) },
    { id: "recent", label: "最近任务", sessions: visible.filter((session) => statePriority(effectiveState(session, taskBySession.get(session.id))) >= 2) },
  ].filter((group) => group.sessions.length > 0);

  return (
    <section className="tasks-view">
      <div className="section-heading task-heading">
        <div>
          <p className="eyebrow">任务管理</p>
          <h2>{projects.length} 个项目</h2>
        </div>
        <span>{managedSessions.length} 个任务 · {activeCount} 个进行中{groupedProcessCount > 0 ? ` · ${groupedProcessCount} 个同目录进程已归组` : ""}</span>
      </div>

      <div className="project-directory" aria-label="项目目录">
        <button className={projectId === "all" ? "active" : ""} onClick={() => setProjectId("all")}>
          <strong>全部项目</strong><small>{managedSessions.length} 个任务</small>
        </button>
        {stableProjects.map((project) => (
          <button key={project.id} className={projectId === project.id ? "active" : ""} onClick={() => setProjectId(project.id)}>
            <strong>{project.name}</strong><small>{project.sessionCount} 个任务 · {project.postCount} 张卡</small>
          </button>
        ))}
      </div>

      <div className="task-tools">
        <label className="task-search">
          <span aria-hidden="true">⌕</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务、项目或目录" aria-label="搜索任务" />
          {query && <button onClick={() => setQuery("")} aria-label="清空搜索">×</button>}
        </label>
        <div className="task-filters" aria-label="任务筛选">
          {FILTERS.map((item) => (
            <button key={item.id} className={filter === item.id ? "active" : ""} onClick={() => { setFilter(item.id); setShowAll(false); }}>{item.label}</button>
          ))}
        </div>
      </div>

      {groups.map((group) => (
        <section className="task-group" key={group.id}>
          <header><h3>{group.label}</h3><span>{group.sessions.length}</span></header>
          <div className="task-list">
            {group.sessions.map((session) => {
              const task = taskBySession.get(session.id);
              const state = effectiveState(session, task);
              const location = sessionLocation(session);
              const processCount = collapsed.counts.get(session.id) ?? 1;
              const tone = statePriority(state) === 0 ? "waiting" : statePriority(state) === 1 ? "running" : session.status;
              return (
                <button className="task-row" key={session.id} onClick={() => onOpen(session.id)}>
                  <span className={`status-dot status-${tone}`} aria-hidden="true" />
                  <span className="task-copy">
                    <strong>{processCount > 1 ? `${runtimeLabel(session.provider)} 在 ${location.label} 运行 ${processCount} 个任务` : taskTitle(session, task)}</strong>
                    <small>{location.kind === "project" ? "项目" : "目录"} · {location.label}<span aria-hidden="true"> · </span>{processCount > 1 ? `${processCount} 个活跃进程已归组` : relativeTaskTime(session.lastActivityAt)}</small>
                  </span>
                  <span className="task-side">
                    <span className={`provider provider-${session.provider}`}>{sessionRuntimeLabel(session)}</span>
                    <small>{stateLabel(session, state)}</small>
                  </span>
                </button>
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
