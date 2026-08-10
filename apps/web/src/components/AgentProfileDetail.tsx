import { useMemo, useRef, useState } from "react";
import { USER_AVATAR_IDS } from "@zimlo/protocol";
import type { ClientCommand, FeedPost, Project, ProjectTrustPolicy, Session, TrustAuditEntry } from "@zimlo/protocol";
import { AppIcon } from "./AppIcon";
import { FormattedText } from "./FormattedText";
import { agentAvatarStyle, agentBio } from "./AgentsView";
import { ProviderBadge } from "./ProviderBadge";
import { AgentAvatar, UserAvatar } from "./UserAvatar";
import { relativeTime, useNow } from "../lib/nowTicker";
import { useModalFocus } from "./useModalFocus";

interface AgentProfileDetailProps {
  project: Project;
  sessions: Session[];
  posts: FeedPost[];
  trustPolicy?: ProjectTrustPolicy | undefined;
  trustAudit?: TrustAuditEntry[] | undefined;
  trustEnabled?: boolean | undefined;
  connected: boolean;
  send: (command: ClientCommand) => boolean;
  onOpenTask: (sessionId: string) => void;
  onNewTask: (projectId: string) => void;
  onClose: () => void;
}

async function copyPath(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}

export function AgentProfileDetail({ project, sessions, posts, trustPolicy, trustAudit = [], trustEnabled = true, connected, send, onOpenTask, onNewTask, onClose }: AgentProfileDetailProps) {
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(project.agentProfile.displayName);
  const [avatar, setAvatar] = useState(project.agentProfile.avatar);
  const [bio, setBio] = useState(project.agentProfile.bio);
  const [defaultProvider, setDefaultProvider] = useState<"codex" | "claude" | "">(project.agentProfile.defaultProvider ?? "");
  const [showAllActivity, setShowAllActivity] = useState(false);
  const [copiedWorkspacePath, setCopiedWorkspacePath] = useState<string | null>(null);
  const now = useNow();
  const panelRef = useRef<HTMLElement | null>(null);
  useModalFocus(panelRef);
  const sessionById = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);
  const visibleBio = agentBio(project);
  const workspacePaths = useMemo(() => [...new Set([project.primaryPath, ...project.paths].filter(Boolean))], [project.paths, project.primaryPath]);
  const timeline = useMemo(() => posts
    .map((post) => ({ id: post.id, at: post.createdAt, post }))
    .sort((left, right) => right.at.localeCompare(left.at)), [posts]);

  return (
    <div className="detail-backdrop" role="presentation">
      <section className="detail-panel agent-profile-detail" role="dialog" aria-modal="true" aria-label={project.agentProfile.displayName} ref={panelRef}>
        <section className="agent-profile-header">
          <div className="detail-page-controls is-agent-profile">
            <button type="button" onClick={onClose} aria-label="返回"><AppIcon name="arrow-left" /></button>
          </div>
          <div className="agent-profile-identity">
            <AgentAvatar avatar={project.agentProfile.avatar} className={`agent-avatar agent-profile-avatar ${agentAvatarStyle(project.id)}`} alt="" />
            <div className="agent-profile-copy">
              <h1>{project.agentProfile.displayName}</h1>
              {project.name !== project.agentProfile.displayName && <span className="agent-project-name">{project.name}</span>}
              <p className={visibleBio ? "" : "is-placeholder"}>{visibleBio ?? "还没有设置专长与工作方式。编辑资料后，团队更容易理解这个 Agent 适合做什么。"}</p>
            </div>
          </div>
          <div className="agent-profile-status" aria-label="Agent 状态">
            <div><strong className={connected ? "is-online" : "is-offline"}><i aria-hidden="true" />{connected ? "在线" : "离线"}</strong><span>连接</span></div>
            <div><strong className="agent-provider-meta">{project.agentProfile.defaultProvider ? <><ProviderBadge provider={project.agentProfile.defaultProvider} labelMode="icon" />{project.agentProfile.defaultProvider === "codex" ? "Codex" : "Claude"}</> : "自动"}</strong><span>Runtime</span></div>
            <div><strong className={trustPolicy?.preset === "safe_automation" ? "is-online" : ""}>{trustPolicy?.preset === "safe_automation" ? "开启" : "询问"}</strong><span>自动化</span></div>
          </div>
          <div className="agent-profile-actions">
            <button className="primary-button" onClick={() => onNewTask(project.id)}>＋ 新任务</button>
            <button className="secondary-button" onClick={() => setEditing((value) => !value)}>{editing ? "取消" : "编辑资料"}</button>
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
        {workspacePaths.length > 0 && <section className="agent-workspace-card" aria-label="工作目录">
          <header>
            <div><span className="eyebrow">WORKSPACE</span><h2>工作目录</h2></div>
            <p>新任务默认使用主目录</p>
          </header>
          <div className="agent-workspace-list">
            {workspacePaths.map((path, index) => (
              <div className="agent-workspace-row" key={path}>
                <div>
                  <span>{index === 0 ? "主目录" : "其他已识别目录"}</span>
                  <code title={path}>{path}</code>
                </div>
                <button type="button" onClick={() => {
                  void copyPath(path).then((copied) => {
                    if (!copied) return;
                    setCopiedWorkspacePath(path);
                    window.setTimeout(() => setCopiedWorkspacePath((current) => current === path ? null : current), 1_800);
                  });
                }}>{copiedWorkspacePath === path ? "已复制" : "复制"}</button>
              </div>
            ))}
          </div>
        </section>}
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
          <header className="timeline-heading"><h2>最近动态</h2>{timeline.length > 3 && <button type="button" onClick={() => setShowAllActivity((current) => !current)}>{showAllActivity ? "收起" : "查看全部"}</button>}</header>
          {timeline.slice(0, showAllActivity ? timeline.length : 3).map((item) => {
            const session = item.post.sessionId ? sessionById.get(item.post.sessionId) : undefined;
            return <article className={`agent-timeline-item timeline-${item.post.kind}`} key={`post:${item.id}`}>
              <AgentAvatar avatar={project.agentProfile.avatar} className={`agent-timeline-avatar ${agentAvatarStyle(project.id)}`} alt="" />
              <div className="agent-timeline-content">
                <div className="agent-timeline-meta"><strong>{project.agentProfile.displayName}</strong><time>{relativeTime(item.at, now)}</time></div>
                <h3>{item.post.headline}</h3><FormattedText text={item.post.takeaway} />
                <div className="agent-timeline-footer"><span>{session ? <>由 <ProviderBadge provider={session.provider} surface={session.surface} /> 执行</> : "重要动态"}</span>{session && <button onClick={() => onOpenTask(session.id)}>查看任务 →</button>}</div>
              </div>
            </article>;
          })}
          {timeline.length === 0 && <div className="timeline-empty"><strong>还没有 Agent 动态</strong><p>布置第一个任务后，重要进展会汇总在这里。</p></div>}
        </section>
      </section>
    </div>
  );
}
