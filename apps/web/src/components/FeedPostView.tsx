import type { ClientCommand, FeedPost, PendingAction, Project, Session } from "@zimlo/protocol";
import { ActionPanel } from "./ActionPanel";
import { FormattedText } from "./FormattedText";
import { sessionLocation, sessionRuntimeLabel } from "./sessionPresentation";

interface FeedPostViewProps {
  post: FeedPost;
  session: Session | undefined;
  project: Project | undefined;
  actions: PendingAction[];
  send: (command: ClientCommand) => void;
  onOpenProject: (projectId: string) => void;
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

function relativeTime(value: string): string {
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(value));
}

export function FeedPostView({ post, session, project, actions, send, onOpenProject, position, total }: FeedPostViewProps) {
  const location = session ? sessionLocation(session) : null;
  return (
    <article className={`feed-post post-${post.kind} template-${post.template} ${post.actionRequired ? "is-attention" : ""}`}>
      <div className="post-topline">
        <div>
          <span className="post-kind">{LABELS[post.kind]}</span>
          <span className="post-author">{project?.agentProfile.displayName ?? post.agentId.toUpperCase()}</span>
        </div>
        <span className="post-position">{String(position).padStart(2, "0")} / {String(total).padStart(2, "0")}</span>
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
        {post.actionPrompt && <p className="post-action-prompt">{post.actionPrompt}</p>}
      </div>

      <div className="post-footer">
        <div className="session-meta">
          <span className={`provider provider-${session?.provider ?? post.agentId}`}>{session ? sessionRuntimeLabel(session) : post.agentId}</span>
          {project ? <button className="agent-project-link" onClick={(event) => { event.stopPropagation(); onOpenProject(project.id); }}>
            <span>{project.agentProfile.avatar}</span>{project.agentProfile.displayName}
          </button> : <span>{location ? `${location.kind === "project" ? "项目" : "目录"} · ${location.label}` : `未归属项目 · ${post.taskId}`}</span>}
          {post.actionRequired && <span className="action-required-badge">需要你处理</span>}
        </div>

        {actions.map((action) => <ActionPanel key={action.actionId} action={action} send={send} compact />)}

      </div>
    </article>
  );
}
