import type { ClientCommand, TaskCommand } from "@zimlo/protocol";
import { runtimeLabel } from "./sessionPresentation";

interface TaskCommandFailureCardProps {
  command: TaskCommand;
  send: (command: ClientCommand) => void;
  position: number;
  total: number;
}

export function TaskCommandFailureCard({ command, send, position, total }: TaskCommandFailureCardProps) {
  const project = command.cwd.split("/").filter(Boolean).at(-1) ?? command.cwd;
  return (
    <article className="feed-post post-failure template-marker command-failure-card">
      <div className="post-topline">
        <div><span className="post-kind">新任务启动失败</span><span className="post-author">ZIMLO</span></div>
        <span className="post-position">{String(position).padStart(2, "0")} / {String(total).padStart(2, "0")}</span>
      </div>
      <div className="post-copy">
        <p className="post-time">需要你处理</p>
        <h2>任务没有成功交给 Agent</h2>
        <p className="post-takeaway">{command.error ?? "Mac 未能启动这个任务。"}</p>
        <ul className="post-highlights"><li>Agent：{runtimeLabel(command.provider)}</li><li>项目：{project}</li><li>Task Input：{command.text.slice(0, 100)}</li></ul>
      </div>
      <div className="post-footer">
        <div className="session-meta"><span className={`provider provider-${command.provider}`}>{runtimeLabel(command.provider)}</span><span>未创建 session</span></div>
        <button className="primary-button" onClick={() => send({ type: "task.command.retry", commandId: command.id, idempotencyKey: crypto.randomUUID() })}>重试任务</button>
      </div>
    </article>
  );
}
