import { memo, useEffect, useState } from "react";
import type { ClientCommand, FeedPost, Material, PendingAction, Project, Session, TaskReview } from "@zimlo/protocol";
import { ActionPanel } from "./ActionPanel";
import { FormattedText } from "./FormattedText";
import { VoiceInput } from "./VoiceInput";
import { sessionLocation } from "./sessionPresentation";
import { ProviderBadge } from "./ProviderBadge";
import { AgentAvatar } from "./UserAvatar";
import { AppIcon } from "./AppIcon";
import { relativeTime, useNow } from "../lib/nowTicker";

interface FeedPostViewProps {
  post: FeedPost;
  materials?: Material[] | undefined;
  session: Session | undefined;
  project: Project | undefined;
  actions: PendingAction[];
  review?: TaskReview | undefined;
  send: (command: ClientCommand) => boolean;
  onOpenProject: (projectId: string) => void;
  needsAction: boolean;
  position: number | null;
  total: number;
  interactionMode?: "swipe" | "desktop";
}

const LABELS: Record<FeedPost["kind"], string> = {
  progress: "阶段成果",
  decision: "新的判断",
  attention: "需要关注",
  result: "结果",
  failure: "失败 / 风险",
};

function sameActionsByIdentity(left: PendingAction[], right: PendingAction[]): boolean {
  return left.length === right.length && left.every((action, index) => action === right[index]);
}

export const FeedPostView = memo(function FeedPostView({ post, materials = [], session, project, actions, review, send, onOpenProject, needsAction, position, total, interactionMode = "swipe" }: FeedPostViewProps) {
  const now = useNow();
  const location = session ? sessionLocation(session) : null;
  const pendingActions = actions.filter((action) => action.state === "pending");
  const content = post.content ?? { type: "text" as const };
  const draftKey = `zimlo:feed-reply:${post.id}`;
  const [reply, setReply] = useState(() => typeof localStorage === "undefined" ? "" : localStorage.getItem(draftKey) ?? "");
  const [submitted, setSubmitted] = useState(false);
  const [reviewNote, setReviewNote] = useState("");
  const canReply = Boolean(session?.cwd && !session.correlationUncertain);
  const directReply = needsAction && pendingActions.length === 0 && post.actions.includes("reply");
  const openTaskHint = interactionMode === "desktop" ? "打开任务查看完整结果" : "左滑查看完整结果";
  const failureHint = interactionMode === "desktop" ? "打开任务查看原因并决定下一步" : "左滑查看原因并决定下一步";
  const nextStep = (needsAction ? post.actionPrompt : null)
    ?? (post.kind === "failure" ? failureHint : post.kind === "result" ? openTaskHint : session?.status === "running" ? "Agent 继续执行，重要变化会再次出现" : "等待下一条重要更新");

  useEffect(() => {
    if (reply) localStorage.setItem(draftKey, reply);
    else localStorage.removeItem(draftKey);
  }, [draftKey, reply]);

  useEffect(() => {
    if (!needsAction) {
      localStorage.removeItem(draftKey);
      setReply("");
      setSubmitted(false);
    }
  }, [draftKey, needsAction]);

  // 发送即清空：outbox 持久化成功后同一交互周期清空输入框与草稿，
  // 本地 pending 消息由 outbox 派生的 queued 指令立即展示。
  const submitReply = () => {
    if (!session || !canReply || !reply.trim() || submitted) return;
    const accepted = send({ type: "task.follow_up", sessionId: session.id, text: reply.trim(), materialIds: [], idempotencyKey: crypto.randomUUID() });
    if (!accepted) return;
    setReply("");
    setSubmitted(true);
  };

  return (
    <article className={`feed-post post-${post.kind} template-${post.template} content-${content.type} ${needsAction ? "is-attention" : ""}`}>
      <div className="post-topline">
        <div>
          <span className="post-kind">{LABELS[post.kind]}</span>
          <span className="post-author">{project?.agentProfile.displayName ?? post.agentId.toUpperCase()}</span>
        </div>
        {position !== null && <span className="post-position">{String(position).padStart(2, "0")} / {String(total).padStart(2, "0")}</span>}
      </div>

      {content.type !== "text" && <FeedMediaCard post={{ ...post, content }} materials={materials} />}
      <div className={`post-copy ${content.type !== "text" ? "post-copy-media" : ""}`}>
        <p className="post-time">{relativeTime(post.createdAt, now)}</p>
        <h2>{post.headline}</h2>
        <div className="post-takeaway"><FormattedText text={post.takeaway} compact /></div>
        {post.highlights.length > 0 && (
          <ul className="post-highlights">
            {post.highlights.slice(0, 2).map((highlight) => <li key={highlight}>{highlight}</li>)}
          </ul>
        )}
        <p className="post-action-prompt"><span>下一步</span>{nextStep}</p>
      </div>

      <div className="post-footer">
        <div className="session-meta">
          {session ? <ProviderBadge provider={session.provider} surface={session.surface} /> : <span>{post.agentId}</span>}
          {project ? <button className="agent-project-link" onClick={(event) => { event.stopPropagation(); onOpenProject(project.id); }}>
            <AgentAvatar avatar={project.agentProfile.avatar} className="agent-project-avatar" alt="" />{project.agentProfile.displayName}
          </button> : <span>{location ? `${location.kind === "project" ? "项目" : "目录"} · ${location.label}` : `未归属项目 · ${post.taskId}`}</span>}
          {needsAction && <span className="action-required-badge">需要你处理</span>}
        </div>

        {pendingActions.map((action) => <ActionPanel key={action.actionId} action={action} send={send} compact />)}
        {directReply && (
          <div className="feed-reply-row">
            <VoiceInput compact value={reply} onChange={setReply} onSubmit={submitReply} rows={1} ariaLabel="直接回复 Agent" placeholder="说出或输入回复…" disabled={!canReply || submitted} />
            <button
              className="action-submit"
              aria-label={submitted ? "回复已保存，等待同步" : canReply ? "发送回复" : "请进入任务回复"}
              title={submitted ? "回复已保存，等待同步" : canReply ? "发送回复" : "请进入任务回复"}
              disabled={!canReply || !reply.trim() || submitted}
              onClick={submitReply}
            ><AppIcon name={submitted ? "check" : "send"} /></button>
          </div>
        )}
        {review?.state === "unreviewed" && (
          <div className="feed-review-actions">
            <button onClick={() => send({ type: "review.respond", reviewId: review.id, decision: "accept", idempotencyKey: crypto.randomUUID() })}>接受结果</button>
            <details>
              <summary>要求修改</summary>
              <textarea value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} rows={2} placeholder="需要修改什么…" />
              <button
                disabled={!reviewNote.trim()}
                onClick={() => {
                  if (send({ type: "review.respond", reviewId: review.id, decision: "request_changes", note: reviewNote.trim(), idempotencyKey: crypto.randomUUID() })) setReviewNote("");
                }}
              >发送</button>
            </details>
          </div>
        )}

      </div>
    </article>
  );
}, (previous, next) =>
  previous.post === next.post
  && previous.materials === next.materials
  && previous.session === next.session
  && previous.project === next.project
  && previous.review === next.review
  && previous.needsAction === next.needsAction
  && previous.position === next.position
  && previous.total === next.total
  && previous.send === next.send
  && previous.onOpenProject === next.onOpenProject
  && sameActionsByIdentity(previous.actions, next.actions),
);

function FeedMediaCard({ post, materials }: { post: FeedPost; materials: Material[] }) {
  const content = post.content ?? { type: "text" as const };
  const byId = new Map(materials.map((material) => [material.id, material]));
  const src = (id: string) => `/api/materials/${encodeURIComponent(id)}/content`;
  if (content.type === "image_album") {
    const values = content.materialIds.flatMap((id) => {
      const material = byId.get(id);
      return material?.status === "ready" ? [material] : [];
    });
    return <div className="feed-image-album" aria-label={`图片组，共 ${values.length} 张`}>
      {values.map((material) => <img key={material.id} src={src(material.id)} alt={material.name} loading="lazy" />)}
      {values.length > 1 && <span>{values.length} 张</span>}
    </div>;
  }
  if (content.type === "video") {
    const material = byId.get(content.materialId);
    const poster = content.posterMaterialId ? byId.get(content.posterMaterialId) : undefined;
    return material?.status === "ready" ? <video className="feed-video" src={src(material.id)} poster={poster ? src(poster.id) : undefined} controls playsInline muted preload="metadata" /> : <MissingMaterial />;
  }
  if (content.type === "document") {
    const material = byId.get(content.materialId);
    if (!material || material.status !== "ready") return <MissingMaterial />;
    return <a className="feed-document" href={src(material.id)} target="_blank" rel="noreferrer">
      {content.coverMaterialId && byId.get(content.coverMaterialId)?.status === "ready"
        ? <img src={src(content.coverMaterialId)} alt="" />
        : <span className="feed-document-icon">{material.kind === "pdf" ? "PDF" : "FILE"}</span>}
      <span><strong>{material.name}</strong><small>{content.summary ?? post.takeaway}</small></span>
      <span aria-hidden="true">↗</span>
    </a>;
  }
  return null;
}

function MissingMaterial() {
  return <div className="feed-material-missing">物料正在同步，连接 Mac 后会自动显示</div>;
}
