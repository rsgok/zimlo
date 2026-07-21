import type { ClientCommand, FeedPost, PendingAction, Session } from "@zimlo/protocol";
import { ActionPanel } from "./ActionPanel";

interface FeedPostViewProps {
  post: FeedPost;
  session: Session | undefined;
  actions: PendingAction[];
  send: (command: ClientCommand) => void;
  onOpen: (sessionId: string) => void;
  position: number;
  total: number;
}

const LABELS: Record<FeedPost["kind"], string> = {
  instruction: "你的指令",
  progress: "阶段进展",
  decision: "判断变化",
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

export function FeedPostView({ post, session, actions, send, onOpen, position, total }: FeedPostViewProps) {
  const canOpen = Boolean(post.sessionId);
  const lightweightActions = post.actions.filter((action) => action === "reply" || action === "open_diff");
  const unboundDecisions = post.actions.filter((action) => (action === "approve" || action === "reject") && actions.length === 0);
  return (
    <article className={`feed-post post-${post.kind}`}>
      <div className="post-topline">
        <div>
          <span className="post-kind">{LABELS[post.kind]}</span>
          <span className="post-author">{post.source === "user" ? "YOU" : post.agentId.toUpperCase()}</span>
        </div>
        <span className="post-position">{String(position).padStart(2, "0")} / {String(total).padStart(2, "0")}</span>
      </div>

      <div className="post-copy">
        <p className="post-time">{relativeTime(post.createdAt)}</p>
        <h2>{post.title}</h2>
        <p className="post-body">{post.body}</p>
      </div>

      <div className="post-footer">
        <div className="session-meta">
          <span className={`provider provider-${session?.provider ?? post.agentId}`}>{session?.provider ?? post.agentId}</span>
          <span>{session?.cwd?.split("/").pop() ?? post.taskId}</span>
          {post.actionRequired && <span className="action-required-badge">需要你处理</span>}
        </div>

        {actions.map((action) => <ActionPanel key={action.actionId} action={action} send={send} />)}

        {(lightweightActions.length > 0 || unboundDecisions.length > 0 || canOpen) && (
          <div className="post-actions">
            {lightweightActions.map((action) => (
              <button key={action} className="primary-button" onClick={() => post.sessionId && onOpen(post.sessionId)}>
                {ACTION_LABELS[action]}
              </button>
            ))}
            {unboundDecisions.map((action) => <span key={action} className="requested-action">请求{ACTION_LABELS[action]}</span>)}
            {canOpen && <button className="text-button" onClick={() => onOpen(post.sessionId!)}>查看任务详情 →</button>}
          </div>
        )}
      </div>
    </article>
  );
}
