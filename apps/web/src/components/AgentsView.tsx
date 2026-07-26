import { useMemo, useState } from "react";
import type { Project, Session } from "@zimlo/protocol";
import { ProviderBadge } from "./ProviderBadge";
import { collapseProcessSessions } from "./TasksView";
import { AgentAvatar } from "./UserAvatar";

interface AgentsViewProps {
  projects: Project[];
  sessions: Session[];
  onOpen: (projectId: string) => void;
  onNewTask: (projectId: string) => void;
}

type AgentFilter = "used" | "active" | "all";

function activeCount(projectId: string, sessions: Session[]): number {
  return sessions.filter((session) => session.projectId === projectId && session.status === "running").length;
}

export function agentBio(project: Project): string | null {
  const bio = project.agentProfile.bio.trim();
  if (!bio || bio === `负责 ${project.name} 项目的长期工作与上下文。`) return null;
  return bio;
}

function relativeAgentTime(value: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "刚刚使用";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前使用`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前使用`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)} 天前使用`;
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(value));
}

export function agentAvatarStyle(projectId: string) {
  const tones = ["agent-tone-lime", "agent-tone-sand", "agent-tone-blue", "agent-tone-violet", "agent-tone-coral"];
  let hash = 0;
  for (const char of projectId) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return tones[Math.abs(hash) % tones.length];
}

export function AgentsView({ projects, sessions, onOpen, onNewTask }: AgentsViewProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AgentFilter>("used");
  const normalized = query.trim().toLocaleLowerCase();
  const groupedSessions = useMemo(() => collapseProcessSessions(sessions).sessions, [sessions]);
  const activeByProject = useMemo(() => new Map(projects.map((project) => [project.id, activeCount(project.id, groupedSessions)])), [groupedSessions, projects]);
  const usedCount = projects.filter((project) => project.sessionCount > 0).length;
  const workingCount = projects.filter((project) => (activeByProject.get(project.id) ?? 0) > 0).length;
  const agents = useMemo(() => [...projects]
    .filter((project) => {
      if (filter === "used" && project.sessionCount === 0) return false;
      if (filter === "active" && (activeByProject.get(project.id) ?? 0) === 0) return false;
      return !normalized || [project.agentProfile.displayName, project.agentProfile.bio, project.name]
        .some((value) => value.toLocaleLowerCase().includes(normalized));
    })
    .sort((left, right) => {
      const activity = (activeByProject.get(right.id) ?? 0) - (activeByProject.get(left.id) ?? 0);
      return activity || right.lastUsedAt.localeCompare(left.lastUsedAt) || left.agentProfile.displayName.localeCompare(right.agentProfile.displayName, "zh-CN", { sensitivity: "base" });
    }), [activeByProject, filter, normalized, projects]);

  return (
    <section className="agents-view">
      <div className="agent-tools">
        <div className="agent-filters" aria-label="Agent 筛选">
          <button className={filter === "used" ? "active" : ""} onClick={() => setFilter("used")}>已启用 <span>{usedCount}</span></button>
          <button className={filter === "active" ? "active" : ""} onClick={() => setFilter("active")}>工作中 <span>{workingCount}</span></button>
          <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>全部 <span>{projects.length}</span></button>
          <details className="directory-search">
            <summary aria-label="搜索 Agent">⌕</summary>
            <div className="directory-search-panel">
              <label className="task-search agent-search">
                <span aria-hidden="true">⌕</span>
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Agent 或项目" aria-label="搜索 Agent" />
                {query && <button onClick={() => setQuery("")} aria-label="清空搜索">×</button>}
              </label>
            </div>
          </details>
        </div>
      </div>

      <div className="agent-directory">
        {agents.map((project) => {
          const running = activeByProject.get(project.id) ?? 0;
          const bio = agentBio(project);
          return (
            <article className={`agent-directory-card${running > 0 ? " is-active" : ""}`} key={project.id}>
              <button className="agent-card-main" onClick={() => onOpen(project.id)}>
                <span className="agent-card-avatar-wrap">
                  <AgentAvatar avatar={project.agentProfile.avatar} className={`agent-avatar ${agentAvatarStyle(project.id)}`} alt="" />
                  <span className={running > 0 ? "agent-presence is-active" : "agent-presence"} aria-hidden="true" />
                </span>
                <span className="agent-card-copy">
                  <span className="agent-card-title">
                    <strong>{project.agentProfile.displayName}</strong>
                    <span>{running > 0 ? `${running} 个进行中` : project.sessionCount > 0 ? "随时可用" : "尚未启用"}</span>
                  </span>
                  {bio && <small>{bio}</small>}
                  <span className="agent-card-meta">
                    <span>{project.name}</span>
                    <span>{project.sessionCount} 个任务</span>
                    <span>{relativeAgentTime(project.lastUsedAt)}</span>
                  </span>
                  <span className="agent-card-runtime">
                    {project.agentProfile.defaultProvider
                      ? <><ProviderBadge provider={project.agentProfile.defaultProvider} labelMode="icon" /><span>默认 Runtime</span></>
                      : project.providers.length > 0
                        ? <>{project.providers.map((provider) => <ProviderBadge provider={provider} labelMode="icon" key={provider} />)}<span>可用 Runtime</span></>
                        : <span>Runtime 自动选择</span>}
                  </span>
                </span>
              </button>
              <button className="agent-quick-task" onClick={() => onNewTask(project.id)}><span aria-hidden="true">＋</span> 布置任务</button>
            </article>
          );
        })}
      </div>
      {agents.length === 0 && (
        <div className="task-empty">
          <strong>{filter === "active" ? "目前没有工作中的 Agent" : "没有找到 Agent"}</strong>
          <p>{filter === "active" ? "可以从“已启用”中选择 Agent 布置新任务。" : "试试项目名，或切换到“全部”查看尚未启用的 Agent。"}</p>
        </div>
      )}
    </section>
  );
}
