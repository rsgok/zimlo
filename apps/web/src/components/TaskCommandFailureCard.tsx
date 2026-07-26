import type { ClientCommand, TaskCommand } from "@zimlo/protocol";
import { ProviderBadge } from "./ProviderBadge";
import { runtimeLabel } from "./sessionPresentation";

interface TaskCommandFailureCardProps {
  command: TaskCommand;
  send: (command: ClientCommand) => void;
  position: number | null;
  total: number;
}

export function TaskCommandFailureCard({ command, send, position, total }: TaskCommandFailureCardProps) {
  const project = command.cwd.split("/").filter(Boolean).at(-1) ?? command.cwd;
  const failed = command.state === "failed";
  return (
    <article className={`feed-post ${failed ? "post-failure template-marker is-attention" : "post-progress template-paper"} command-failure-card`}>
      <div className="post-topline">
        <div><span className="post-kind">{failed ? "新任务启动失败" : "正在启动"}</span><span className="post-author">ZIMLO</span></div>
        {position !== null && <span className="post-position">{String(position).padStart(2, "0")} / {String(total).padStart(2, "0")}</span>}
      </div>
      <div className="post-copy">
        <p className="post-time">{failed ? "需要你处理" : "任务已经进入可靠队列"}</p>
        <h2>{failed ? "任务没有成功交给 Agent" : `${runtimeLabel(command.provider)} 正在接收任务`}</h2>
        <p className="post-takeaway">{failed ? command.error ?? "Mac 未能启动这个任务。" : command.text}</p>
        <ul className="post-highlights"><li>Runtime：{runtimeLabel(command.provider)}</li><li>项目：{project}</li></ul>
      </div>
      <div className="post-footer">
        <div className="session-meta"><ProviderBadge provider={command.provider} labelMode="icon" /><span>未创建 session</span></div>
        {failed && <button className="primary-button" onClick={() => send({ type: "task.command.retry", commandId: command.id, idempotencyKey: crypto.randomUUID() })}>重试任务</button>}
      </div>
    </article>
  );
}
