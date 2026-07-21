import type { Session } from "@zimlo/protocol";

interface TasksViewProps {
  sessions: Session[];
  onOpen: (sessionId: string) => void;
}

export function TasksView({ sessions, onOpen }: TasksViewProps) {
  return (
    <section className="tasks-view">
      <div className="section-heading">
        <p className="eyebrow">自动发现</p>
        <h2>{sessions.length} 个 Session</h2>
      </div>
      <div className="task-list">
        {sessions.map((session) => (
          <button className="task-row" key={session.id} onClick={() => onOpen(session.id)}>
            <span className={`status-dot status-${session.status}`} aria-hidden="true" />
            <span className="task-copy">
              <strong>{session.title}</strong>
              <small>{session.cwd ?? "工作目录未知"}</small>
            </span>
            <span className="task-side">
              <span className={`provider provider-${session.provider}`}>{session.provider}</span>
              <small>{session.capabilities.replyable ? "可回复" : session.activePid ? "外部终端运行中" : "只读"}</small>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
