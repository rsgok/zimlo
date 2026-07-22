import { useEffect, useMemo, useState } from "react";
import type { ClientCommand, Project, Provider, TrustedWorkspace } from "@zimlo/protocol";
import { VoiceInput } from "./VoiceInput";

interface TaskComposerProps {
  workspaces: TrustedWorkspace[];
  projects: Project[];
  initialProjectId?: string | null;
  send: (command: ClientCommand) => boolean;
  onClose: () => void;
  onSubmitted?: () => void;
}

export function defaultWorkspaceId(workspaces: TrustedWorkspace[], preferredId?: string, savedId?: string | null): string {
  if (preferredId && workspaces.some((workspace) => workspace.id === preferredId)) return preferredId;
  if (savedId && workspaces.some((workspace) => workspace.id === savedId)) return savedId;
  return [...workspaces].sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt) || left.id.localeCompare(right.id))[0]?.id ?? "";
}

export function TaskComposer({ workspaces, projects, initialProjectId = null, send, onClose, onSubmitted }: TaskComposerProps) {
  const initialProject = projects.find((project) => project.id === initialProjectId);
  const preferredWorkspace = workspaces.find((workspace) => initialProject?.paths.includes(workspace.path));
  const savedWorkspace = typeof localStorage === "undefined" ? null : localStorage.getItem("zimlo:last-workspace");
  const savedProvider = typeof localStorage === "undefined" ? null : localStorage.getItem("zimlo:last-provider");
  const savedDraft = typeof localStorage === "undefined" ? "" : localStorage.getItem("zimlo:new-task-draft") ?? "";
  const [provider, setProvider] = useState<Provider>(initialProject?.agentProfile.defaultProvider ?? (savedProvider === "claude" ? "claude" : "codex"));
  const [workspaceId, setWorkspaceId] = useState(() => defaultWorkspaceId(workspaces, preferredWorkspace?.id, savedWorkspace));
  const [text, setText] = useState(savedDraft);
  const [projectQuery, setProjectQuery] = useState("");
  const projectByPath = useMemo(() => new Map(projects.flatMap((project) => project.paths.map((path) => [path, project] as const))), [projects]);
  const visibleWorkspaces = useMemo(() => {
    const normalized = projectQuery.trim().toLocaleLowerCase();
    return !normalized ? workspaces : workspaces.filter((workspace) => {
      const agent = projectByPath.get(workspace.path);
      return [workspace.label, workspace.path, agent?.agentProfile.displayName].some((value) => value?.toLocaleLowerCase().includes(normalized));
    });
  }, [projectByPath, projectQuery, workspaces]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  useEffect(() => {
    localStorage.setItem("zimlo:new-task-draft", text);
  }, [text]);

  const selectedWorkspace = workspaces.find((workspace) => workspace.id === workspaceId);
  const selectedAgent = selectedWorkspace ? projectByPath.get(selectedWorkspace.path) : undefined;

  return (
    <div className="composer-backdrop" role="presentation">
      <section className="new-task-sheet" role="dialog" aria-modal="true" aria-labelledby="new-task-title">
        <header>
          <div><p className="eyebrow">NEW TASK</p><h2 id="new-task-title">布置新任务</h2></div>
          <button onClick={onClose} aria-label="关闭新任务">×</button>
        </header>
        <label>
          <span>Runtime</span>
          <select value={provider} onChange={(event) => setProvider(event.target.value as Provider)}>
            <option value="codex">Codex</option>
            <option value="claude">Claude Code</option>
          </select>
        </label>
        <label>
          <span>Project Agent</span>
          <input className="composer-project-search" value={projectQuery} onChange={(event) => setProjectQuery(event.target.value)} placeholder="搜索 Agent、项目或路径" aria-label="搜索 Project Agent" />
          <select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} disabled={workspaces.length === 0}>
            {visibleWorkspaces.map((workspace) => {
              const agent = projectByPath.get(workspace.path);
              return <option value={workspace.id} key={workspace.id}>{agent?.agentProfile.displayName ?? workspace.label} · {workspace.path}</option>;
            })}
          </select>
          {selectedAgent && <small className="composer-agent-hint">将交给 {selectedAgent.agentProfile.displayName}，由 {provider === "codex" ? "Codex" : "Claude Code"} 执行</small>}
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
            const accepted = send({ type: "task.create", provider, workspaceId, text: text.trim(), idempotencyKey: crypto.randomUUID() });
            if (!accepted) return;
            localStorage.setItem("zimlo:last-workspace", workspaceId);
            localStorage.setItem("zimlo:last-provider", provider);
            localStorage.removeItem("zimlo:new-task-draft");
            onSubmitted?.();
            onClose();
          }}
        >开始任务</button>
      </section>
    </div>
  );
}
