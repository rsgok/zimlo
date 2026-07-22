import { useEffect, useState } from "react";
import type { ClientCommand, Provider, TrustedWorkspace } from "@zimlo/protocol";
import { VoiceInput } from "./VoiceInput";

interface TaskComposerProps {
  workspaces: TrustedWorkspace[];
  send: (command: ClientCommand) => void;
  onClose: () => void;
}

export function TaskComposer({ workspaces, send, onClose }: TaskComposerProps) {
  const [provider, setProvider] = useState<Provider>("codex");
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "");
  const [text, setText] = useState("");

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  return (
    <div className="composer-backdrop" role="presentation">
      <section className="new-task-sheet" role="dialog" aria-modal="true" aria-labelledby="new-task-title">
        <header>
          <div><p className="eyebrow">NEW TASK</p><h2 id="new-task-title">布置新任务</h2></div>
          <button onClick={onClose} aria-label="关闭新任务">×</button>
        </header>
        <label>
          <span>Agent</span>
          <select value={provider} onChange={(event) => setProvider(event.target.value as Provider)}>
            <option value="codex">Codex</option>
            <option value="claude">Claude Code</option>
          </select>
        </label>
        <label>
          <span>项目</span>
          <select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} disabled={workspaces.length === 0}>
            {workspaces.map((workspace) => <option value={workspace.id} key={workspace.id}>{workspace.label} · {workspace.path}</option>)}
          </select>
        </label>
        <label>
          <span>Task Input</span>
          <VoiceInput autoFocus rows={4} value={text} onChange={setText} ariaLabel="Task Input" placeholder="说出或输入你想完成什么…" />
        </label>
        {workspaces.length === 0 && <p className="composer-warning">先在 Mac 的 Codex 或 Claude Code 中打开一次项目，Zimlo 才会把它加入可信列表。</p>}
        <button
          className="new-task-submit"
          disabled={!workspaceId || !text.trim()}
          onClick={() => {
            send({ type: "task.create", provider, workspaceId, text: text.trim(), idempotencyKey: crypto.randomUUID() });
            onClose();
          }}
        >开始任务</button>
      </section>
    </div>
  );
}
