import { useEffect, useState } from "react";
import type { ClientCommand, FeedPost, PendingAction, Session, UnifiedEvent } from "@zimlo/protocol";
import { ActionPanel } from "./ActionPanel";

interface SessionDetailProps {
  session: Session;
  events: UnifiedEvent[];
  actions: PendingAction[];
  posts: FeedPost[];
  send: (command: ClientCommand) => void;
  onClose: () => void;
}

function readablePayload(payload: unknown): string {
  if (typeof payload === "string") return payload;
  return JSON.stringify(payload, null, 2);
}

function eventTitle(event: UnifiedEvent): string {
  return event.kind.replaceAll("_", " ");
}

function instructionText(event: UnifiedEvent): string {
  if (!event.payload || typeof event.payload !== "object") return readablePayload(event.payload);
  const prompt = (event.payload as Record<string, unknown>).prompt;
  return typeof prompt === "string" ? prompt : readablePayload(event.payload);
}

export function SessionDetail({ session, events, actions, posts, send, onClose }: SessionDetailProps) {
  const [message, setMessage] = useState("");
  const diffEvents = events.filter((event) => event.kind === "files_changed");
  const instructions = events.filter((event) => event.kind === "user_instruction");
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  return (
    <div className="detail-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="detail-panel" role="dialog" aria-modal="true" aria-labelledby="detail-title">
        <header className="detail-header">
          <div>
            <p className="eyebrow">{session.provider} · {session.status}</p>
            <h2 id="detail-title">{session.title}</h2>
            <p className="detail-path">{session.cwd ?? "工作目录未知"}</p>
          </div>
          <button className="close-button" onClick={onClose} aria-label="关闭详情">×</button>
        </header>

        {session.correlationUncertain && (
          <div className="warning-banner">Zimlo 没有足够强的证据把该进程与某个 transcript 合并，因此保留为独立 Session。</div>
        )}
        {actions.map((action) => <ActionPanel key={action.actionId} action={action} send={send} />)}

        {instructions.length > 0 && (
          <section className="detail-section task-origins">
            <h3>任务起点</h3>
            <p className="muted">你交给 Agent 的原始指令只保留在任务详情，不进入主 Feed。</p>
            {[...instructions].reverse().map((event) => (
              <details className="instruction-row" key={event.id}>
                <summary>
                  <span>{instructionText(event).slice(0, 280)}{instructionText(event).length > 280 ? "…" : ""}</span>
                  <small>{new Date(event.occurredAt).toLocaleString("zh-CN")}</small>
                </summary>
                {instructionText(event).length > 280 && <pre>{instructionText(event)}</pre>}
              </details>
            ))}
          </section>
        )}

        {posts.length > 0 && (
          <section className="detail-section detail-posts">
            <h3>Feed 更新</h3>
            {[...posts].reverse().map((post) => (
              <article key={post.id}>
                <strong>{post.headline}</strong>
                <p>{post.takeaway}</p>
                {post.highlights.length > 0 && <ul>{post.highlights.map((item) => <li key={item}>{item}</li>)}</ul>}
                {post.proof && <small>已验证：{post.proof}</small>}
              </article>
            ))}
          </section>
        )}

        <section className="reply-section">
          <div>
            <h3>继续任务</h3>
            <p>{session.capabilities.replyable ? "Zimlo 将通过安全 resume 创建受控 turn。" : session.activePid ? "该 Session 正在其他终端运行；Zimlo 不会注入 TTY。" : "当前连接方式不支持回复。"}</p>
          </div>
          <textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={3} disabled={!session.capabilities.replyable} placeholder="回复 Agent…" />
          <button
            className="primary-button"
            disabled={!session.capabilities.replyable || !message.trim()}
            onClick={() => {
              send({ type: "session.message", sessionId: session.id, text: message.trim(), idempotencyKey: crypto.randomUUID() });
              setMessage("");
            }}
          >发送并继续</button>
        </section>

        {diffEvents.length > 0 && (
          <section className="detail-section">
            <h3>{session.capabilities.diffAvailable ? "Session Diff" : "文件变化"}</h3>
            {!session.capabilities.diffAvailable && <p className="muted">来源不足以安全归属时，Zimlo 不会把普通工作区 Diff 标成某个 Agent 的修改。</p>}
            {diffEvents.slice(-8).map((event) => <pre className="diff-block" key={event.id}>{readablePayload(event.payload)}</pre>)}
          </section>
        )}

        <section className="detail-section">
          <h3>关键事件</h3>
          <div className="event-list">
            {[...events].filter((event) => event.kind !== "user_instruction").reverse().map((event) => (
              <details className="event-row" key={event.id}>
                <summary>
                  <span>{eventTitle(event)}</span>
                  <small>{new Date(event.occurredAt).toLocaleString("zh-CN")} · {event.provenance}</small>
                </summary>
                <pre>{readablePayload(event.payload)}</pre>
              </details>
            ))}
          </div>
        </section>
      </section>
    </div>
  );
}
