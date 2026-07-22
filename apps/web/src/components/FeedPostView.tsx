import type { ClientCommand, FeedPost, PendingAction, Session } from "@zimlo/protocol";
import { ActionPanel } from "./ActionPanel";
import { runtimeLabel, sessionLocation } from "./sessionPresentation";

interface FeedPostViewProps {
  post: FeedPost;
  session: Session | undefined;
  actions: PendingAction[];
  send: (command: ClientCommand) => void;
  onOpen: (sessionId: string) => void;
  onOpenDiff: (sessionId: string) => void;
  position: number;
  total: number;
}

const LABELS: Record<FeedPost["kind"], string> = {
  progress: "阶段成果",
  decision: "新的判断",
  attention: "需要关注",
  result: "结果",
  failure: "失败 / 风险",
};

const ACTION_LABELS: Record<FeedPost["actions"][number], string> = {
  approve: "批准",
  reject: "拒绝",
  reply: "回复",
  open_diff: "查看 Diff",
};

function relativeTime(value: string): string {
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(value));
}

export function FeedPostView({ post, session, actions, send, onOpen, onOpenDiff, position, total }: FeedPostViewProps) {
  const location = session ? sessionLocation(session) : null;
  const lightweightActions = post.actions.filter((action) => action === "open_diff" || (action === "reply" && actions.length === 0));
  const unboundDecisions = post.actionRequired
    ? post.actions.filter((action) => (action === "approve" || action === "reject") && actions.length === 0)
    : [];
  return (
    <article className={`feed-post post-${post.kind} template-${post.template}`}>
      <div className="post-topline">
        <div>
          <span className="post-kind">{LABELS[post.kind]}</span>
          <span className="post-author">{post.agentId.toUpperCase()}</span>
        </div>
        <span className="post-position">{String(position).padStart(2, "0")} / {String(total).padStart(2, "0")}</span>
      </div>

      <div className="post-copy">
        <p className="post-time">{relativeTime(post.createdAt)}</p>
        <h2>{post.headline}</h2>
        <p className="post-takeaway">{post.takeaway}</p>
        {post.highlights.length > 0 && (
          <ul className="post-highlights">
            {post.highlights.map((highlight) => <li key={highlight}>{highlight}</li>)}
          </ul>
        )}
        {post.proof && <p className="post-proof"><span>已验证</span>{post.proof}</p>}
        {post.actionPrompt && <p className="post-action-prompt">{post.actionPrompt}</p>}
      </div>

      <div className="post-footer">
        <div className="session-meta">
          <span className={`provider provider-${session?.provider ?? post.agentId}`}>{session ? runtimeLabel(session.provider) : post.agentId}</span>
          <span>{location ? `${location.kind === "project" ? "项目" : "目录"} · ${location.label}` : `任务 · ${post.taskId}`}</span>
          {post.actionRequired && <span className="action-required-badge">需要你处理</span>}
        </div>

        {actions.map((action) => <ActionPanel key={action.actionId} action={action} send={send} compact />)}

        {(lightweightActions.length > 0 || unboundDecisions.length > 0) && (
          <div className="post-actions">
            {lightweightActions.map((action) => (
              <button key={action} className={action === "open_diff" ? "secondary-button" : "primary-button"} onClick={() => post.sessionId && (action === "open_diff" ? onOpenDiff(post.sessionId) : onOpen(post.sessionId))}>
                {ACTION_LABELS[action]}
              </button>
            ))}
            {unboundDecisions.map((action) => <span key={action} className="requested-action">请求{ACTION_LABELS[action]}</span>)}
          </div>
        )}
      </div>
    </article>
  );
}
