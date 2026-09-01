import type { ClientCommand, PendingAction, Session } from "@zimlo/protocol";
import { ActionPanel } from "./ActionPanel";
import { ProviderIcon } from "./ProviderBadge";
import { runtimeLabel, sessionLocation } from "./sessionPresentation";

interface ActionFeedCardProps {
  action: PendingAction;
  session: Session | undefined;
  send: (command: ClientCommand) => boolean;
}

export function ActionFeedCard({ action, session, send }: ActionFeedCardProps) {
  const location = session ? sessionLocation(session) : null;
  const risk = action.availableDecisions.some((decision) => decision.risk === "high")
    ? "高风险"
    : action.availableDecisions.some((decision) => decision.risk === "medium") ? "中风险" : "低风险";
  const purpose = action.detail.split("\n").find((line) => line.startsWith("目的："))?.slice(3);
  const taskReference = session?.providerSessionId.slice(0, 8) ?? action.sessionId.slice(0, 8);
  const title = action.title === "需要批准操作" && /(?:^|\n)(?:命令：)?(?:[A-Z_]+=|\w[\w-]*\s)/u.test(action.detail)
    ? "批准执行命令"
    : action.title;
  const subject = session?.title ?? `${session ? runtimeLabel(session.provider) : "Agent"} 任务 ${taskReference}…`;
  const takeaway = purpose
    ? `${purpose}。请确认这一步是否符合你的预期。`
    : `“${subject}”需要你确认这一步；“允许一次”影响范围最小，拒绝后 Agent 会停在当前步骤。`;
  return (
    <article className="feed-post post-attention system-attention-card is-attention action-feed-card">
      <div className="post-topline">
        <div><span className="post-kind">需要你处理</span><span className="post-author">{session ? <ProviderIcon provider={session.provider} /> : "AGENT"}</span></div>
      </div>
      <div className="post-copy">
        <p className="post-time">刚刚</p>
        <h2>{title}</h2>
        <p className="post-takeaway">{action.kind === "input" ? `“${subject}”正在等待你的回答，提交后会继续执行。` : takeaway}</p>
        <p className="action-risk-note">{action.kind === "approval" ? `${risk} · 请明确批准或拒绝` : "提交回答后任务会继续"}</p>
      </div>
      <div className="post-footer">
        <ActionPanel action={action} send={send} compact />
      </div>
    </article>
  );
}
