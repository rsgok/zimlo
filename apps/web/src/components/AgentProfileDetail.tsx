import { useMemo, useState } from "react";
import type { ClientCommand, FeedPost, Project, Session, TaskCommand, UserAvatarId } from "@zimlo/protocol";
import { FormattedText } from "./FormattedText";
import { agentAvatarStyle } from "./AgentsView";
import { runtimeLabel, sessionRuntimeLabel } from "./sessionPresentation";
import { UserAvatar } from "./UserAvatar";

interface AgentProfileDetailProps {
  project: Project;
  sessions: Session[];
  posts: FeedPost[];
  commands: TaskCommand[];
  userAvatarId: UserAvatarId;
  send: (command: ClientCommand) => boolean;
  onOpenTask: (sessionId: string) => void;
  onNewTask: (projectId: string) => void;
  onClose: () => void;
}

function relativeTime(value: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)} 天前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(value));
}

export function AgentProfileDetail({ project, sessions, posts, commands, userAvatarId, send, onOpenTask, onNewTask, onClose }: AgentProfileDetailProps) {
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(project.agentProfile.displayName);
  const [avatar, setAvatar] = useState(project.agentProfile.avatar);
  const [bio, setBio] = useState(project.agentProfile.bio);
  const [defaultProvider, setDefaultProvider] = useState<"codex" | "claude" | "">(project.agentProfile.defaultProvider ?? "");
  const sessionIds = useMemo(() => new Set(sessions.map((session) => session.id)), [sessions]);
  const sessionById = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);
  const running = sessions.filter((session) => ["running", "waiting"].includes(session.status)).length;
  const timeline = useMemo(() => [
    ...posts.map((post) => ({ type: "post" as const, id: post.id, at: post.createdAt, post })),
    ...commands.filter((command) => (command.sessionId && sessionIds.has(command.sessionId)) || command.workspaceId === project.id)
      .map((command) => ({ type: "command" as const, id: command.id, at: command.createdAt, command })),
  ].sort((left, right) => right.at.localeCompare(left.at)), [commands, posts, project.id, sessionIds]);

  return (
    <div className="detail-backdrop" role="presentation">
      <section className="detail-panel agent-profile-detail" role="dialog" aria-modal="true" aria-labelledby="agent-profile-title">
        <header className="detail-nav">
          <button className="detail-back-button" onClick={onClose} aria-label="返回 Agents">←</button>
          <div><strong id="agent-profile-title">{project.agentProfile.displayName}</strong><small>Project Agent Profile</small></div>
        </header>
        <section className="agent-profile-header">
          <span className={`agent-avatar agent-profile-avatar ${agentAvatarStyle(project.id)}`}>{project.agentProfile.avatar}</span>
          <div className="agent-profile-actions">
            <button className="secondary-button" onClick={() => setEditing((value) => !value)}>{editing ? "取消" : "编辑"}</button>
            <button className="primary-button" onClick={() => onNewTask(project.id)}>布置任务</button>
          </div>
          <h1>{project.agentProfile.displayName}</h1>
          <p>{project.agentProfile.bio}</p>
          <div className="agent-profile-meta">
            <span>项目 · {project.name}</span>
            <span>{running} 个进行中</span>
            <span>默认 · {project.agentProfile.defaultProvider ? runtimeLabel(project.agentProfile.defaultProvider) : "自动选择"}</span>
          </div>
          {editing && (
            <form className="agent-profile-editor" onSubmit={(event) => {
              event.preventDefault();
              if (send({ type: "agent.profile.update", projectId: project.id, displayName: displayName.trim(), avatar: avatar.trim(), bio: bio.trim(), defaultProvider: defaultProvider || null })) setEditing(false);
            }}>
              <label><span>头像（Emoji 或文字）</span><input value={avatar} maxLength={16} onChange={(event) => setAvatar(event.target.value)} /></label>
              <label><span>Agent 名称</span><input value={displayName} maxLength={80} onChange={(event) => setDisplayName(event.target.value)} /></label>
              <label><span>一句话简介</span><textarea value={bio} maxLength={280} rows={3} onChange={(event) => setBio(event.target.value)} /></label>
              <label><span>默认 Runtime</span><select value={defaultProvider} onChange={(event) => setDefaultProvider(event.target.value as "codex" | "claude" | "")}><option value="">自动选择</option><option value="codex">Codex</option><option value="claude">Claude Code</option></select></label>
              <button className="primary-button" disabled={!displayName.trim() || !avatar.trim()}>保存 Agent Profile</button>
            </form>
          )}
        </section>
        <section className="agent-timeline" aria-label="Agent Timeline">
          <header className="timeline-heading"><h2>Timeline</h2><span>跨任务 · 最新在上</span></header>
          {timeline.map((item) => {
            if (item.type === "command") {
              const session = item.command.sessionId ? sessionById.get(item.command.sessionId) : undefined;
              return <article className="agent-timeline-item is-user" key={`command:${item.id}`}>
                <UserAvatar avatarId={userAvatarId} className="agent-timeline-avatar" alt="" />
                <div className="agent-timeline-content">
                  <div className="agent-timeline-meta"><strong>你</strong><time>{relativeTime(item.at)}</time></div>
                  <FormattedText text={item.command.text} />
                  <div className="agent-timeline-footer"><span>{item.command.state === "running" ? "执行中" : item.command.state === "queued" ? "已排队" : item.command.state === "failed" ? "发送失败" : "已发送"}</span>{session && <button onClick={() => onOpenTask(session.id)}>查看 Task Detail →</button>}</div>
                </div>
              </article>;
            }
            const session = item.post.sessionId ? sessionById.get(item.post.sessionId) : undefined;
            return <article className={`agent-timeline-item timeline-${item.post.kind}`} key={`post:${item.id}`}>
              <div className={`agent-timeline-avatar ${agentAvatarStyle(project.id)}`} aria-hidden="true">{project.agentProfile.avatar}</div>
              <div className="agent-timeline-content">
                <div className="agent-timeline-meta"><strong>{project.agentProfile.displayName}</strong><time>{relativeTime(item.at)}</time></div>
                <h3>{item.post.headline}</h3><FormattedText text={item.post.takeaway} />
                <div className="agent-timeline-footer"><span>{session ? `由 ${sessionRuntimeLabel(session)} 执行` : "重要动态"}</span>{session && <button onClick={() => onOpenTask(session.id)}>查看 Task Detail →</button>}</div>
              </div>
            </article>;
          })}
          {timeline.length === 0 && <div className="timeline-empty"><strong>还没有 Agent 动态</strong><p>布置第一个任务后，重要进展会汇总在这里。</p></div>}
        </section>
      </section>
    </div>
  );
}
