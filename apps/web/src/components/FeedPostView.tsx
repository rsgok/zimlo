import { useEffect, useState } from "react";
import type { ClientCommand, FeedPost, PendingAction, Project, Session, TaskReview } from "@zimlo/protocol";
import { ActionPanel } from "./ActionPanel";
import { FormattedText } from "./FormattedText";
import { VoiceInput } from "./VoiceInput";
import { sessionLocation } from "./sessionPresentation";
import { ProviderBadge } from "./ProviderBadge";
import { AgentAvatar } from "./UserAvatar";

interface FeedPostViewProps {
  post: FeedPost;
  session: Session | undefined;
  project: Project | undefined;
  actions: PendingAction[];
  review?: TaskReview | undefined;
  send: (command: ClientCommand) => boolean;
  onOpenProject: (projectId: string) => void;
  needsAction: boolean;
  position: number | null;
  total: number;
}

const LABELS: Record<FeedPost["kind"], string> = {
  progress: "阶段成果",
  decision: "新的判断",
  attention: "需要关注",
  result: "结果",
  failure: "失败 / 风险",
};

function relativeTime(value: string): string {
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(value));
}

export function FeedPostView({ post, session, project, actions, review, send, onOpenProject, needsAction, position, total }: FeedPostViewProps) {
  const location = session ? sessionLocation(session) : null;
  const pendingActions = actions.filter((action) => action.state === "pending");
  const draftKey = `zimlo:feed-reply:${post.id}`;
  const [reply, setReply] = useState(() => typeof localStorage === "undefined" ? "" : localStorage.getItem(draftKey) ?? "");
  const [submitted, setSubmitted] = useState(false);
  const [reviewNote, setReviewNote] = useState("");
  const canReply = Boolean(session?.cwd && !session.correlationUncertain);
  const directReply = needsAction && pendingActions.length === 0 && post.actions.includes("reply");
  const nextStep = (needsAction ? post.actionPrompt : null)
    ?? (post.kind === "failure" ? "左滑查看原因并决定下一步" : post.kind === "result" ? "左滑查看完整结果" : session?.status === "running" ? "Agent 继续执行，重要变化会再次出现" : "等待下一条重要更新");

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
  return (
    <article className={`feed-post post-${post.kind} template-${post.template} ${needsAction ? "is-attention" : ""}`}>
      <div className="post-topline">
        <div>
          <span className="post-kind">{LABELS[post.kind]}</span>
          <span className="post-author">{project?.agentProfile.displayName ?? post.agentId.toUpperCase()}</span>
        </div>
        {position !== null && <span className="post-position">{String(position).padStart(2, "0")} / {String(total).padStart(2, "0")}</span>}
      </div>

      <div className="post-copy">
        <p className="post-time">{relativeTime(post.createdAt)}</p>
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
            <VoiceInput compact value={reply} onChange={setReply} rows={1} ariaLabel="直接回复 Agent" placeholder="说出或输入回复…" disabled={!canReply || submitted} />
            <button
              className="action-submit"
              disabled={!canReply || !reply.trim() || submitted}
              onClick={() => {
                const accepted = send({ type: "task.follow_up", sessionId: session!.id, text: reply.trim(), idempotencyKey: crypto.randomUUID() });
                if (!accepted) return;
                setSubmitted(true);
              }}
            >{submitted ? "已保存待同步" : canReply ? "回复" : "请进入任务回复"}</button>
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
}
