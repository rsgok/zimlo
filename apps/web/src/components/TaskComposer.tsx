import { useEffect, useMemo, useRef, useState } from "react";
import type { ClientCommand, Project, Provider, TrustedWorkspace } from "@zimlo/protocol";
import { agentAvatarStyle } from "./AgentsView";
import { ProviderBadge } from "./ProviderBadge";
import { AgentAvatar } from "./UserAvatar";
import { useModalFocus } from "./useModalFocus";
import { VoiceInput } from "./VoiceInput";
import { formatMaterialSize, labelForKind, uploadMaterial, validateFile, type PreparedMaterial } from "../lib/materials";

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
  const projectByPath = useMemo(() => new Map(projects.flatMap((project) => project.paths.map((path) => [path, project] as const))), [projects]);
  const initialProject = projects.find((project) => project.id === initialProjectId);
  const preferredWorkspace = workspaces.find((workspace) => initialProject?.paths.includes(workspace.path));
  const savedWorkspace = typeof localStorage === "undefined" ? null : localStorage.getItem("zimlo:last-workspace");
  const savedProvider = typeof localStorage === "undefined" ? null : localStorage.getItem("zimlo:last-provider");
  const savedDraft = typeof localStorage === "undefined" ? "" : localStorage.getItem("zimlo:new-task-draft") ?? "";
  const initialWorkspaceId = defaultWorkspaceId(workspaces, preferredWorkspace?.id, savedWorkspace);
  const initialWorkspace = workspaces.find((workspace) => workspace.id === initialWorkspaceId);
  const preferredProvider = initialProject?.agentProfile.defaultProvider ?? (savedProvider === "claude" ? "claude" : "codex");
  const initialProvider = initialWorkspace?.providers.includes(preferredProvider) ? preferredProvider : initialWorkspace?.providers[0] ?? preferredProvider;
  const [provider, setProvider] = useState<Provider>(initialProvider);
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId);
  const [text, setText] = useState(savedDraft);
  const [projectQuery, setProjectQuery] = useState("");
  const [choosingAgent, setChoosingAgent] = useState(false);
  const [materials, setMaterials] = useState<Array<{
    id: string;
    file: File;
    state: "uploading" | "ready" | "failed";
    prepared?: PreparedMaterial;
    error?: string;
  }>>([]);
  const attachmentInput = useRef<HTMLInputElement | null>(null);
  const materialURLs = useRef(new Set<string>());
  const sending = useRef(false);
  const sheetRef = useRef<HTMLElement | null>(null);
  useModalFocus(sheetRef);
  const orderedWorkspaces = useMemo(() => [...workspaces].sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt) || left.label.localeCompare(right.label, "zh-CN")), [workspaces]);
  const visibleWorkspaces = useMemo(() => {
    const normalized = projectQuery.trim().toLocaleLowerCase();
    return !normalized ? orderedWorkspaces : orderedWorkspaces.filter((workspace) => {
      const agent = projectByPath.get(workspace.path);
      return [workspace.label, workspace.path, agent?.agentProfile.displayName].some((value) => value?.toLocaleLowerCase().includes(normalized));
    });
  }, [orderedWorkspaces, projectByPath, projectQuery]);

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

  useEffect(() => () => {
    for (const url of materialURLs.current) URL.revokeObjectURL(url);
    materialURLs.current.clear();
  }, []);

  const uploadOne = async (id: string, file: File) => {
    setMaterials((current) => current.map((item) => {
      if (item.id !== id) return item;
      const { error: _error, ...rest } = item;
      return { ...rest, state: "uploading" };
    }));
    try {
      const prepared = await uploadMaterial(file);
      materialURLs.current.add(prepared.localPreviewURL);
      if (!send(prepared.registerCommand)) throw new Error("物料登记未能保存，请重试");
      setMaterials((current) => current.map((item) => item.id === id ? { ...item, state: "ready", prepared } : item));
    } catch (error) {
      setMaterials((current) => current.map((item) => item.id === id ? { ...item, state: "failed", error: error instanceof Error ? error.message : String(error) } : item));
    }
  };

  const addFiles = async (files: File[]) => {
    const available = Math.max(0, 10 - materials.length);
    let selectedBytes = materials.reduce((total, item) => total + item.file.size, 0);
    for (const file of files.slice(0, available)) {
      const validation = validateFile(file);
      const id = crypto.randomUUID();
      if ("error" in validation) {
        setMaterials((current) => [...current, { id, file, state: "failed", error: validation.error }]);
        continue;
      }
      if (selectedBytes + file.size > 80 * 1024 * 1024) {
        setMaterials((current) => [...current, { id, file, state: "failed", error: "单个任务的物料总大小不能超过 80MB" }]);
        continue;
      }
      selectedBytes += file.size;
      setMaterials((current) => [...current, { id, file, state: "uploading" }]);
      await uploadOne(id, file);
    }
  };

  const removeMaterial = (id: string) => {
    setMaterials((current) => current.filter((item) => {
      if (item.id === id && item.prepared) URL.revokeObjectURL(item.prepared.localPreviewURL);
      if (item.id === id && item.prepared) materialURLs.current.delete(item.prepared.localPreviewURL);
      return item.id !== id;
    }));
  };

  const selectedWorkspace = workspaces.find((workspace) => workspace.id === workspaceId);
  const selectedAgent = selectedWorkspace ? projectByPath.get(selectedWorkspace.path) : undefined;
  const agentName = selectedAgent?.agentProfile.displayName ?? selectedWorkspace?.label ?? "选择 Agent";
  const agentAvatar = selectedAgent?.agentProfile.avatar ?? "●";
  const availableProviders = selectedWorkspace?.providers.length ? selectedWorkspace.providers : (["codex", "claude"] satisfies Provider[]);

  const chooseWorkspace = (nextWorkspace: TrustedWorkspace) => {
    setWorkspaceId(nextWorkspace.id);
    const nextAgent = projectByPath.get(nextWorkspace.path);
    const nextDefault = nextAgent?.agentProfile.defaultProvider;
    if (nextDefault && nextWorkspace.providers.includes(nextDefault)) setProvider(nextDefault);
    else if (!nextWorkspace.providers.includes(provider) && nextWorkspace.providers[0]) setProvider(nextWorkspace.providers[0]);
    setProjectQuery("");
    setChoosingAgent(false);
  };

  return (
    <div className="composer-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <section className="new-task-sheet" role="dialog" aria-modal="true" aria-labelledby="new-task-title" ref={sheetRef}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
        onDrop={(event) => { event.preventDefault(); void addFiles([...event.dataTransfer.files]); }}
        onPaste={(event) => {
          const files = [...event.clipboardData.files];
          if (files.length) { event.preventDefault(); void addFiles(files); }
        }}>
        <header className="new-task-header">
          <div>
            <h2 id="new-task-title">新任务</h2>
            <p>说清目标，Agent 会在后台继续推进。</p>
          </div>
          <button onClick={onClose} aria-label="关闭新任务">×</button>
        </header>
        <div className="new-task-scroll">
          <section className="composer-brief" aria-labelledby="task-brief-label">
            <div className="composer-field-heading">
              <strong id="task-brief-label">你想完成什么？</strong>
              <span>{text.trim() ? "草稿已保存" : "草稿自动保存"}</span>
            </div>
            <VoiceInput autoFocus rows={6} value={text} onChange={setText} ariaLabel="任务目标" placeholder="例如：检查首页白屏原因，修复后跑完测试并告诉我结果…" />
            <div className="composer-material-toolbar">
              <input ref={attachmentInput} type="file" multiple hidden accept="image/jpeg,image/png,image/webp,image/heic,image/heif,video/mp4,video/quicktime,video/x-m4v,application/pdf,text/plain,text/markdown,text/csv,application/json,.doc,.docx,.xls,.xlsx,.ppt,.pptx" onChange={(event) => { void addFiles([...event.target.files ?? []]); event.currentTarget.value = ""; }} />
              <button type="button" onClick={() => attachmentInput.current?.click()} disabled={materials.length >= 10}>
                <span aria-hidden="true">＋</span> 添加图片、视频或文件
              </button>
              <span>可拖入或粘贴 · 最多 10 个</span>
            </div>
            {materials.length > 0 && <div className="composer-material-list" aria-label="已选择物料">
              {materials.map((item) => {
                const kind = validateFile(item.file);
                const label = "kind" in kind ? labelForKind(kind.kind) : "文件";
                return <article className={`composer-material-item is-${item.state}`} key={item.id}>
                  {item.prepared && item.prepared.material.kind === "image"
                    ? <img src={item.prepared.localPreviewURL} alt="" />
                    : item.prepared && item.prepared.material.kind === "video"
                      ? <video src={item.prepared.localPreviewURL} muted preload="metadata" />
                      : <span className="composer-material-type">{label}</span>}
                  <span className="composer-material-copy"><strong>{item.file.name}</strong><small>{formatMaterialSize(item.file.size)} · {item.state === "uploading" ? "正在加密上传" : item.state === "ready" ? "已安全保存" : item.error}</small></span>
                  <span className="composer-material-actions">
                    {item.state === "failed" && <button type="button" aria-label={`重试 ${item.file.name}`} onClick={() => { void uploadOne(item.id, item.file); }}>↻</button>}
                    <button type="button" aria-label={`移除 ${item.file.name}`} onClick={() => removeMaterial(item.id)}>×</button>
                  </span>
                </article>;
              })}
            </div>}
            <p>直接描述想要的结果；Agent 会自己拆解步骤，需要决定时再来找你。</p>
          </section>

          <section className="composer-destination" aria-labelledby="composer-destination-title">
            <div className="composer-field-heading">
              <strong id="composer-destination-title">交给谁</strong>
              <span>已沿用最近选择</span>
            </div>
            <button
              type="button"
              className="composer-assignee"
              aria-expanded={choosingAgent}
              aria-controls="composer-agent-chooser"
              onClick={() => setChoosingAgent((value) => !value)}
              disabled={workspaces.length === 0}
            >
              <AgentAvatar avatar={agentAvatar} className={`composer-agent-avatar ${selectedAgent ? agentAvatarStyle(selectedAgent.id) : ""}`} alt="" />
              <span className="composer-assignee-copy">
                <strong>{agentName}</strong>
                <small>{selectedAgent ? `${selectedAgent.name} · 已记住项目上下文` : selectedWorkspace?.label ?? "暂无可信项目"}</small>
              </span>
              <ProviderBadge provider={provider} labelMode="icon" />
              <span className="composer-change-label">{choosingAgent ? "收起" : "更换"}</span>
            </button>

            {choosingAgent && (
              <div className="composer-agent-chooser" id="composer-agent-chooser">
                <label className="composer-project-search">
                  <span aria-hidden="true">⌕</span>
                  <input value={projectQuery} onChange={(event) => setProjectQuery(event.target.value)} placeholder="搜索 Agent 或项目" aria-label="搜索 Agent" />
                </label>
                <div className="composer-agent-list" role="radiogroup" aria-label="选择 Agent">
                  {visibleWorkspaces.map((workspace) => {
                    const agent = projectByPath.get(workspace.path);
                    const selected = workspace.id === workspaceId;
                    return (
                      <button type="button" role="radio" aria-checked={selected} className={selected ? "selected" : ""} onClick={() => chooseWorkspace(workspace)} key={workspace.id}>
                        <AgentAvatar avatar={agent?.agentProfile.avatar ?? "●"} className={`composer-agent-option-avatar ${agent ? agentAvatarStyle(agent.id) : ""}`} alt="" />
                        <span>
                          <strong>{agent?.agentProfile.displayName ?? workspace.label}</strong>
                          <small>{agent?.name ?? workspace.label}</small>
                        </span>
                        <span className="composer-agent-runtimes">
                          {workspace.providers.map((item) => <ProviderBadge provider={item} labelMode="icon" key={item} />)}
                        </span>
                        {selected && <span className="composer-selected-check" aria-hidden="true">✓</span>}
                      </button>
                    );
                  })}
                  {visibleWorkspaces.length === 0 && <p className="composer-empty-search">没有匹配的 Agent</p>}
                </div>
                <div className="composer-runtime-choice">
                  <span>执行方式</span>
                  <div role="radiogroup" aria-label="选择执行方式">
                    {(["codex", "claude"] satisfies Provider[]).map((item) => (
                      <button type="button" role="radio" aria-checked={provider === item} className={provider === item ? "selected" : ""} disabled={!availableProviders.includes(item)} onClick={() => setProvider(item)} key={item}>
                        <ProviderBadge provider={item} labelMode="icon" />
                        <span>{item === "codex" ? "Codex" : "Claude Code"}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </section>

          {workspaces.length === 0 && <p className="composer-warning">先在 Mac 的 Codex 或 Claude Code 中打开一次项目，Zimlo 才能安全地把任务交给它。</p>}
        </div>
        <footer className="new-task-footer">
          <div>
            <strong>{workspaceId ? `交给 ${agentName}` : "还没有可用 Agent"}</strong>
            <span>提交后可离开，任务会继续运行</span>
          </div>
          <button
            className="new-task-submit"
            disabled={!workspaceId || !text.trim() || materials.some((item) => item.state !== "ready")}
            onClick={() => {
              if (sending.current) return;
              sending.current = true;
              const accepted = send({ type: "task.create", provider, workspaceId, text: text.trim(), materialIds: materials.flatMap((item) => item.prepared ? [item.prepared.material.id] : []), idempotencyKey: crypto.randomUUID() });
              if (!accepted) {
                sending.current = false;
                return;
              }
              localStorage.setItem("zimlo:last-workspace", workspaceId);
              localStorage.setItem("zimlo:last-provider", provider);
              localStorage.removeItem("zimlo:new-task-draft");
              onSubmitted?.();
              onClose();
            }}
          >开始任务 <span aria-hidden="true">→</span></button>
        </footer>
      </section>
    </div>
  );
}
