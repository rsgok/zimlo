import type { ClientCommand, FeedCard, PendingAction, Session } from "@zimlo/protocol";
import { ActionPanel } from "./ActionPanel";

interface FeedCardViewProps {
  card: FeedCard;
  session: Session | undefined;
  actions: PendingAction[];
  send: (command: ClientCommand) => void;
  onOpen: (sessionId: string) => void;
}

const LABELS: Record<FeedCard["kind"], string> = {
  attention: "等待你",
  progress: "进展",
  result: "代码与测试",
  completed: "已完成",
  failure: "需关注",
};

function relativeTime(value: string): string {
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(value));
}

export function FeedCardView({ card, session, actions, send, onOpen }: FeedCardViewProps) {
  return (
    <article className={`feed-card card-${card.kind}`}>
      <div className="card-topline">
        <span className="card-label">{LABELS[card.kind]}</span>
        <span>{relativeTime(card.updatedAt)}</span>
      </div>
      <button className="card-body-button" onClick={() => onOpen(card.sessionId)}>
        <h2>{card.title}</h2>
        <p className="card-summary">{card.summary}</p>
        <div className="session-meta">
          <span className={`provider provider-${session?.provider ?? "unknown"}`}>{session?.provider ?? "unknown"}</span>
          <span>{session?.cwd?.split("/").pop() ?? "未知项目"}</span>
          {session?.correlationUncertain && <span title="Zimlo 没有把这个进程与 transcript 强行合并">关联待确认</span>}
        </div>
      </button>
      {actions.map((action) => <ActionPanel key={action.actionId} action={action} send={send} />)}
      <button className="text-button" onClick={() => onOpen(card.sessionId)}>查看详情 →</button>
    </article>
  );
}
