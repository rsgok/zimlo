import type { ClientCommand, PendingAction, Session } from "@zimlo/protocol";
import { ActionPanel } from "./ActionPanel";
import { runtimeLabel, sessionLocation } from "./sessionPresentation";

interface ActionFeedCardProps {
  action: PendingAction;
  session: Session | undefined;
  send: (command: ClientCommand) => void;
  position: number;
  total: number;
}

export function ActionFeedCard({ action, session, send, position, total }: ActionFeedCardProps) {
  const location = session ? sessionLocation(session) : null;
  return (
    <article className="feed-post post-attention template-marker action-feed-card">
      <div className="post-topline">
        <div><span className="post-kind">需要你处理</span><span className="post-author">ZIMLO</span></div>
        <span className="post-position">{String(position).padStart(2, "0")} / {String(total).padStart(2, "0")}</span>
      </div>
      <div className="post-copy">
        <p className="post-time">刚刚</p>
        <h2>{action.title}</h2>
        <p className="post-takeaway">这项任务正在等待你的{action.kind === "input" ? "回答" : "批准"}，处理后 Agent 会继续工作。</p>
      </div>
      <div className="post-footer">
        <div className="session-meta">
          <span className={`provider provider-${session?.provider ?? "codex"}`}>{session ? runtimeLabel(session.provider) : "Agent"}</span>
          <span>{location ? `${location.kind === "project" ? "项目" : "目录"} · ${location.label}` : "任务"}</span>
          <span className="action-required-badge">需要你处理</span>
        </div>
        <ActionPanel action={action} send={send} compact />
      </div>
    </article>
  );
}
