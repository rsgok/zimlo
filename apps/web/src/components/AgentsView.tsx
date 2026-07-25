import { useMemo, useState } from "react";
import type { Project, Session } from "@zimlo/protocol";
import { runtimeLabel } from "./sessionPresentation";
import { AgentAvatar } from "./UserAvatar";

interface AgentsViewProps {
  projects: Project[];
  sessions: Session[];
  onOpen: (projectId: string) => void;
  onNewTask: (projectId: string) => void;
}

function activeCount(projectId: string, sessions: Session[]): number {
  return sessions.filter((session) => session.projectId === projectId && ["running", "waiting"].includes(session.status)).length;
}

export function agentAvatarStyle(projectId: string) {
  const tones = ["agent-tone-lime", "agent-tone-sand", "agent-tone-blue", "agent-tone-violet", "agent-tone-coral"];
  let hash = 0;
  for (const char of projectId) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return tones[Math.abs(hash) % tones.length];
}

export function AgentsView({ projects, sessions, onOpen, onNewTask }: AgentsViewProps) {
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLocaleLowerCase();
  const agents = useMemo(() => [...projects]
    .filter((project) => !normalized || [project.agentProfile.displayName, project.agentProfile.bio, project.name]
      .some((value) => value.toLocaleLowerCase().includes(normalized)))
    .sort((left, right) => left.agentProfile.displayName.localeCompare(right.agentProfile.displayName, "zh-CN", { sensitivity: "base" }) || left.id.localeCompare(right.id)), [normalized, projects]);

  return (
    <section className="agents-view">
      <div className="section-heading agent-directory-heading">
        <div><p className="eyebrow">PROJECT AGENTS</p><h2>Agents</h2></div>
        <span>{projects.length} 个长期 Agent</span>
      </div>
      <label className="task-search agent-search">
        <span aria-hidden="true">⌕</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Agent 或项目" aria-label="搜索 Agent" />
        {query && <button onClick={() => setQuery("")} aria-label="清空搜索">×</button>}
      </label>
      <div className="agent-directory">
        {agents.map((project) => {
          const running = activeCount(project.id, sessions);
          return (
            <article className="agent-directory-card" key={project.id}>
              <button className="agent-card-main" onClick={() => onOpen(project.id)}>
                <AgentAvatar avatar={project.agentProfile.avatar} className={`agent-avatar ${agentAvatarStyle(project.id)}`} alt="" />
                <span className="agent-card-copy">
                  <strong>{project.agentProfile.displayName}</strong>
                  <small>{project.agentProfile.bio}</small>
                  <span>{project.name} · {project.sessionCount} 个任务{running > 0 ? ` · ${running} 个进行中` : ""}</span>
                </span>
                <span className="agent-card-runtime">{project.agentProfile.defaultProvider ? runtimeLabel(project.agentProfile.defaultProvider) : "自动选择 Runtime"}</span>
              </button>
              <button className="agent-quick-task" onClick={() => onNewTask(project.id)}>＋ 布置任务</button>
            </article>
          );
        })}
      </div>
      {agents.length === 0 && <div className="task-empty"><strong>没有找到 Agent</strong><p>Agent 默认使用 Project 名称，也可以在详情页改名。</p></div>}
    </section>
  );
}
