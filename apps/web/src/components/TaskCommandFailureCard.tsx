import type { ClientCommand, TaskCommand } from "@zimlo/protocol";
import { runtimeLabel } from "./sessionPresentation";

interface TaskCommandFailureCardProps {
  command: TaskCommand;
  send: (command: ClientCommand) => void;
}

export function TaskCommandFailureCard({ command, send }: TaskCommandFailureCardProps) {
  const failed = command.state === "failed";
  return (
    <article className={`feed-post ${failed ? "post-failure system-attention-card is-attention" : "post-progress system-neutral-card"} command-failure-card`}>
      <div className="post-topline">
        <div><span className="post-kind">{failed ? "新任务启动失败" : "正在启动"}</span><span className="post-author">ZIMLO</span></div>
      </div>
      <div className="post-copy">
        <p className="post-time">{failed ? "需要你处理" : "任务已经进入可靠队列"}</p>
        <h2>{failed ? "任务没有成功交给 Agent" : `${runtimeLabel(command.provider)} 正在接收任务`}</h2>
        <p className="post-takeaway">{failed ? command.error ?? "Mac 未能启动这个任务。" : command.text}</p>
      </div>
      <div className="post-footer">
        {failed && <button className="primary-button" onClick={() => send({ type: "task.command.retry", commandId: command.id, idempotencyKey: crypto.randomUUID() })}>重试任务</button>}
      </div>
    </article>
  );
}
