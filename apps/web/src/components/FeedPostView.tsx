import { memo, useEffect, useState } from "react";
import { createPortal } from "react-dom";
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

interface MediaPreview {
  kind: "image" | "video" | "document";
  url: string;
  name: string;
  mimeType: string;
}

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
  const [mediaPreview, setMediaPreview] = useState<MediaPreview | null>(null);
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

      {content.type !== "text" && <FeedMediaCard post={{ ...post, content }} materials={materials} onPreview={setMediaPreview} />}
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
            <button onClick={() => send({ type: "review.respond", reviewId: review.id, decision: "accept", idempotencyKey: crypto.randomUUID() })}>接受</button>
            <details>
              <summary>修改</summary>
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
      {mediaPreview && <FeedMediaViewer preview={mediaPreview} onClose={() => setMediaPreview(null)} />}
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

function FeedMediaCard({ post, materials, onPreview }: { post: FeedPost; materials: Material[]; onPreview: (preview: MediaPreview) => void }) {
  const content = post.content ?? { type: "text" as const };
  const byId = new Map(materials.map((material) => [material.id, material]));
  const src = (id: string) => `/api/materials/${encodeURIComponent(id)}/content`;
  if (content.type === "image_album") {
    const values = content.materialIds.flatMap((id) => {
      const material = byId.get(id);
      return material?.status === "ready" ? [material] : [];
    });
    return <div className="feed-image-album" aria-label={`图片组，共 ${values.length} 张`}>
      {values.map((material) => <button
        type="button"
        className="feed-image-preview"
        key={material.id}
        aria-label={`查看图片：${material.name}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => onPreview({ kind: "image", url: src(material.id), name: material.name, mimeType: material.mimeType })}
      ><img src={src(material.id)} alt={material.name} loading="lazy" /></button>)}
      {values.length > 1 && <span>{values.length} 张</span>}
    </div>;
  }
  if (content.type === "video") {
    const material = byId.get(content.materialId);
    const poster = content.posterMaterialId ? byId.get(content.posterMaterialId) : undefined;
    return material?.status === "ready" ? <div className="feed-video-shell">
      <video className="feed-video" src={src(material.id)} poster={poster ? src(poster.id) : undefined} playsInline muted preload="metadata" />
      <button
        type="button"
        className="feed-video-open"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => onPreview({ kind: "video", url: src(material.id), name: material.name, mimeType: material.mimeType })}
        aria-label={`播放视频：${material.name}`}
      ><span aria-hidden="true">▶</span><strong>播放</strong></button>
    </div> : <MissingMaterial />;
  }
  if (content.type === "document") {
    const material = byId.get(content.materialId);
    if (!material || material.status !== "ready") return <MissingMaterial />;
    return <button
      type="button"
      className="feed-document"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => onPreview({ kind: "document", url: src(material.id), name: material.name, mimeType: material.mimeType })}
    >
      {content.coverMaterialId && byId.get(content.coverMaterialId)?.status === "ready"
        ? <img src={src(content.coverMaterialId)} alt="" />
        : <span className="feed-document-icon">{material.kind === "pdf" ? "PDF" : "FILE"}</span>}
      <span><strong>{material.name}</strong><small>{content.summary ?? post.takeaway}</small></span>
      <span aria-hidden="true">↗</span>
    </button>;
  }
  return null;
}

function FeedMediaViewer({ preview, onClose }: { preview: MediaPreview; onClose: () => void }) {
  const [textContent, setTextContent] = useState<string | null>(null);
  const [textError, setTextError] = useState(false);
  const isText = preview.kind === "document"
    && (preview.mimeType.startsWith("text/") || preview.mimeType === "application/json");

  useEffect(() => {
    const controller = new AbortController();
    if (isText) {
      setTextContent(null);
      setTextError(false);
      fetch(preview.url, { signal: controller.signal })
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.text();
        })
        .then(setTextContent)
        .catch((error: unknown) => {
          if (!(error instanceof DOMException && error.name === "AbortError")) setTextError(true);
        });
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      controller.abort();
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isText, onClose, preview.url]);

  return createPortal(
    <div className="feed-media-viewer" role="dialog" aria-modal="true" aria-label={`预览 ${preview.name}`} onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div className="feed-media-viewer-panel">
        <header><strong>{preview.name}</strong><button type="button" onClick={onClose} aria-label="关闭预览">×</button></header>
        <div className="feed-media-viewer-content">
          {preview.kind === "image" && <img src={preview.url} alt={preview.name} />}
          {preview.kind === "video" && <video src={preview.url} controls autoPlay playsInline />}
          {preview.kind === "document" && !isText && <iframe src={preview.url} title={preview.name} />}
          {isText && textContent !== null && <pre>{textContent}</pre>}
          {isText && textContent === null && !textError && <div className="feed-media-viewer-state">正在读取…</div>}
          {isText && textError && <div className="feed-media-viewer-state">预览失败，请关闭后重试</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function MissingMaterial() {
  return <div className="feed-material-missing">物料正在同步，连接 Mac 后会自动显示</div>;
}
