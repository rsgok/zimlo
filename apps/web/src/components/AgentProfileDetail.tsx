import { useMemo, useState } from "react";
import { USER_AVATAR_IDS } from "@zimlo/protocol";
import type { ClientCommand, FeedPost, Project, ProjectTrustPolicy, Session, TaskCommand, TrustAuditEntry, UserAvatarId } from "@zimlo/protocol";
import { AppTopBar } from "./AppTopBar";
import { FormattedText } from "./FormattedText";
import { agentAvatarStyle, agentBio } from "./AgentsView";
import { ProviderBadge } from "./ProviderBadge";
import { collapseProcessSessions } from "./TasksView";
import { AgentAvatar, UserAvatar } from "./UserAvatar";

interface AgentProfileDetailProps {
  project: Project;
  sessions: Session[];
  posts: FeedPost[];
  commands: TaskCommand[];
  trustPolicy?: ProjectTrustPolicy | undefined;
  trustAudit?: TrustAuditEntry[] | undefined;
  trustEnabled?: boolean | undefined;
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

export function AgentProfileDetail({ project, sessions, posts, commands, trustPolicy, trustAudit = [], trustEnabled = true, userAvatarId, send, onOpenTask, onNewTask, onClose }: AgentProfileDetailProps) {
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(project.agentProfile.displayName);
  const [avatar, setAvatar] = useState(project.agentProfile.avatar);
  const [bio, setBio] = useState(project.agentProfile.bio);
  const [defaultProvider, setDefaultProvider] = useState<"codex" | "claude" | "">(project.agentProfile.defaultProvider ?? "");
  const [showAllActivity, setShowAllActivity] = useState(false);
  const sessionIds = useMemo(() => new Set(sessions.map((session) => session.id)), [sessions]);
  const sessionById = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);
  const running = collapseProcessSessions(sessions).sessions.filter((session) => session.status === "running").length;
  const visibleBio = agentBio(project);
  const timeline = useMemo(() => [
    ...posts.map((post) => ({ type: "post" as const, id: post.id, at: post.createdAt, post })),
    ...commands.filter((command) => (command.sessionId && sessionIds.has(command.sessionId)) || command.workspaceId === project.id)
      .map((command) => ({ type: "command" as const, id: command.id, at: command.createdAt, command })),
  ].sort((left, right) => right.at.localeCompare(left.at)), [commands, posts, project.id, sessionIds]);

  return (
    <div className="detail-backdrop" role="presentation">
      <section className="detail-panel agent-profile-detail" role="dialog" aria-modal="true" aria-label={project.agentProfile.displayName}>
        <AppTopBar detail title={project.agentProfile.displayName} onBack={onClose} action={<button className="app-top-bar-action" onClick={() => onNewTask(project.id)}>＋ 新任务</button>} />
        <section className="agent-profile-header">
          <AgentAvatar avatar={project.agentProfile.avatar} className={`agent-avatar agent-profile-avatar ${agentAvatarStyle(project.id)}`} alt="" />
          <div className="agent-profile-actions">
            <button className="secondary-button" onClick={() => setEditing((value) => !value)}>{editing ? "取消" : "编辑"}</button>
            <button className="primary-button" onClick={() => onNewTask(project.id)}>＋ 新任务</button>
          </div>
          <h1>{project.agentProfile.displayName}</h1>
          <p className={visibleBio ? "" : "is-placeholder"}>{visibleBio ?? "还没有设置专长与工作方式。编辑资料后，团队更容易理解这个 Agent 适合做什么。"}</p>
          <div className="agent-profile-meta">
            <span>项目 · {project.name}</span>
            <span>{project.sessionCount} 个历史任务</span>
            <span>{running > 0 ? `${running} 个正在工作` : "当前空闲"}</span>
            <span>最近 · {relativeTime(project.lastUsedAt)}</span>
            <span className="agent-provider-meta">默认 · {project.agentProfile.defaultProvider ? <ProviderBadge provider={project.agentProfile.defaultProvider} labelMode="icon" /> : "自动选择"}</span>
          </div>
          {editing && (
            <form className="agent-profile-editor" onSubmit={(event) => {
              event.preventDefault();
              if (send({ type: "agent.profile.update", projectId: project.id, displayName: displayName.trim(), avatar: avatar.trim(), bio: bio.trim(), defaultProvider: defaultProvider || null })) setEditing(false);
            }}>
              <div className="agent-avatar-field">
                <span>头像</span>
                <div className="agent-avatar-picker" role="list" aria-label="选择 Agent 头像">
                  {USER_AVATAR_IDS.map((avatarId, index) => (
                    <button
                      type="button"
                      role="listitem"
                      className={avatarId === avatar ? "selected" : ""}
                      aria-label={`选择 Agent 头像 ${index + 1}`}
                      aria-pressed={avatarId === avatar}
                      key={avatarId}
                      onClick={() => setAvatar(avatarId)}
                    ><UserAvatar avatarId={avatarId} alt="" /></button>
                  ))}
                </div>
              </div>
              <label><span>Agent 名称</span><input value={displayName} maxLength={80} onChange={(event) => setDisplayName(event.target.value)} /></label>
              <label><span>默认 Runtime</span><select value={defaultProvider} onChange={(event) => setDefaultProvider(event.target.value as "codex" | "claude" | "")}><option value="">自动选择</option><option value="codex">Codex</option><option value="claude">Claude Code</option></select></label>
              <label><span>一句话简介</span><textarea value={bio} maxLength={280} rows={3} onChange={(event) => setBio(event.target.value)} /></label>
              <button className="primary-button" disabled={!displayName.trim() || !avatar.trim()}>保存 Agent 资料</button>
            </form>
          )}
        </section>
        {trustEnabled && <section className="agent-trust-card" aria-label="自动化权限">
          <div>
            <span className="eyebrow">AUTOMATION</span>
            <h2>自动化权限</h2>
            <p>{trustPolicy?.preset === "safe_automation" ? "项目内读取、搜索、测试和构建可自动继续；写入、联网和发布仍会询问。" : "所有需要授权的动作都会先询问你。"}</p>
          </div>
          <button
            role="switch"
            aria-checked={trustPolicy?.preset === "safe_automation"}
            className={`switch ${trustPolicy?.preset === "safe_automation" ? "switch-on" : ""}`}
            onClick={() => send({
              type: "trust.policy.update",
              projectId: project.id,
              preset: trustPolicy?.preset === "safe_automation" ? "ask" : "safe_automation",
              idempotencyKey: crypto.randomUUID(),
            })}
          ><span /></button>
          {trustAudit.length > 0 && <details><summary>最近自动化记录</summary>{trustAudit.slice(0, 8).map((entry) => <p key={entry.id}><strong>{entry.decision === "auto_allowed" ? "自动允许" : "已询问"}</strong> · {entry.category} · {entry.actionSummary}</p>)}</details>}
        </section>}
        <section className="agent-timeline" aria-label="Agent Timeline">
          <header className="timeline-heading"><h2>重要动态</h2><span>跨任务汇总 · 最新在上</span></header>
          {timeline.slice(0, showAllActivity ? timeline.length : 8).map((item) => {
            if (item.type === "command") {
              const session = item.command.sessionId ? sessionById.get(item.command.sessionId) : undefined;
              return <article className="agent-timeline-item is-user" key={`command:${item.id}`}>
                <UserAvatar avatarId={userAvatarId} className="agent-timeline-avatar" alt="" />
                <div className="agent-timeline-content">
                  <div className="agent-timeline-meta"><strong>你</strong><time>{relativeTime(item.at)}</time></div>
                  <FormattedText text={item.command.text} />
                  <div className="agent-timeline-footer"><span>{item.command.state === "running" ? "执行中" : item.command.state === "queued" ? "已排队" : item.command.state === "failed" ? "发送失败" : "已发送"}</span>{session && <button onClick={() => onOpenTask(session.id)}>查看任务 →</button>}</div>
                </div>
              </article>;
            }
            const session = item.post.sessionId ? sessionById.get(item.post.sessionId) : undefined;
            return <article className={`agent-timeline-item timeline-${item.post.kind}`} key={`post:${item.id}`}>
              <AgentAvatar avatar={project.agentProfile.avatar} className={`agent-timeline-avatar ${agentAvatarStyle(project.id)}`} alt="" />
              <div className="agent-timeline-content">
                <div className="agent-timeline-meta"><strong>{project.agentProfile.displayName}</strong><time>{relativeTime(item.at)}</time></div>
                <h3>{item.post.headline}</h3><FormattedText text={item.post.takeaway} />
                <div className="agent-timeline-footer"><span>{session ? <>由 <ProviderBadge provider={session.provider} surface={session.surface} /> 执行</> : "重要动态"}</span>{session && <button onClick={() => onOpenTask(session.id)}>查看任务 →</button>}</div>
              </div>
            </article>;
          })}
          {!showAllActivity && timeline.length > 8 && (
            <button className="agent-timeline-more" onClick={() => setShowAllActivity(true)}>查看其余 {timeline.length - 8} 条历史动态</button>
          )}
          {timeline.length === 0 && <div className="timeline-empty"><strong>还没有 Agent 动态</strong><p>布置第一个任务后，重要进展会汇总在这里。</p></div>}
        </section>
      </section>
    </div>
  );
}
