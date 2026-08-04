import { useEffect, useMemo, useRef, useState } from "react";
import type { ClientCommand, Project, Provider, Session, TrustedWorkspace } from "@zimlo/protocol";
import { agentAvatarStyle } from "./AgentsView";
import { ProviderBadge } from "./ProviderBadge";
import { AgentAvatar } from "./UserAvatar";
import { useModalFocus } from "./useModalFocus";
import { VoiceInput } from "./VoiceInput";
import { AppIcon } from "./AppIcon";
import { formatMaterialSize, labelForKind, uploadMaterial, validateFile, type PreparedMaterial } from "../lib/materials";

interface TaskComposerProps {
  workspaces: TrustedWorkspace[];
  projects: Project[];
  initialProjectId?: string | null;
  session?: Session | null | undefined;
  send: (command: ClientCommand) => boolean;
  onClose: () => void;
  onSubmitted?: () => void;
}

type NewTaskStep = "input" | "agent" | "runtime";

export function defaultWorkspaceId(workspaces: TrustedWorkspace[], preferredId?: string, savedId?: string | null): string {
  if (preferredId && workspaces.some((workspace) => workspace.id === preferredId)) return preferredId;
  if (savedId && workspaces.some((workspace) => workspace.id === savedId)) return savedId;
  return [...workspaces].sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt) || left.id.localeCompare(right.id))[0]?.id ?? "";
}

export function TaskComposer({ workspaces, projects, initialProjectId = null, session = null, send, onClose, onSubmitted }: TaskComposerProps) {
  const projectByPath = useMemo(() => new Map(projects.flatMap((project) => project.paths.map((path) => [path, project] as const))), [projects]);
  const initialProject = projects.find((project) => project.id === (session?.projectId ?? initialProjectId));
  const preferredWorkspace = workspaces.find((workspace) => initialProject?.paths.includes(workspace.path));
  const savedWorkspace = typeof localStorage === "undefined" ? null : localStorage.getItem("zimlo:last-workspace");
  const savedProvider = typeof localStorage === "undefined" ? null : localStorage.getItem("zimlo:last-provider");
  const draftKey = session ? `zimlo:task-draft:${session.id}` : "zimlo:new-task-draft";
  const savedDraft = typeof localStorage === "undefined" ? "" : localStorage.getItem(draftKey) ?? "";
  const initialWorkspaceId = defaultWorkspaceId(workspaces, preferredWorkspace?.id, savedWorkspace);
  const initialWorkspace = workspaces.find((workspace) => workspace.id === initialWorkspaceId);
  const preferredProvider = initialProject?.agentProfile.defaultProvider ?? (savedProvider === "claude" ? "claude" : "codex");
  const initialProvider = initialWorkspace?.providers.includes(preferredProvider) ? preferredProvider : initialWorkspace?.providers[0] ?? preferredProvider;
  const [provider, setProvider] = useState<Provider>(initialProvider);
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId);
  const [text, setText] = useState(savedDraft);
  const [projectQuery, setProjectQuery] = useState("");
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const [step, setStep] = useState<NewTaskStep>("input");
  const [runtimeConfirmed, setRuntimeConfirmed] = useState(false);
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
    if (text) localStorage.setItem(draftKey, text);
    else localStorage.removeItem(draftKey);
  }, [draftKey, text]);

  useEffect(() => {
    if (!voiceNotice) return;
    const timer = window.setTimeout(() => setVoiceNotice(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [voiceNotice]);

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
      const targetHostId = session?.hostId ?? selectedWorkspace?.hostId ?? initialProject?.hostId;
      const prepared = await uploadMaterial(file, targetHostId);
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
  const conversationAgent = session ? initialProject ?? selectedAgent : undefined;
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
    setRuntimeConfirmed(false);
    setStep("runtime");
  };

  const contentReady = Boolean(text.trim() && materials.every((item) => item.state === "ready"));
  const canSubmit = session
    ? contentReady
    : Boolean(workspaceId && contentReady && runtimeConfirmed && availableProviders.includes(provider));
  const submit = () => {
    if (!canSubmit || sending.current) return;
    sending.current = true;
    const materialIds = materials.flatMap((item) => item.prepared ? [item.prepared.material.id] : []);
    const accepted = session
      ? send({ type: "task.follow_up", sessionId: session.id, text: text.trim(), materialIds, idempotencyKey: crypto.randomUUID() })
      : send({ type: "task.create", provider, workspaceId, text: text.trim(), materialIds, idempotencyKey: crypto.randomUUID() });
    if (!accepted) {
      sending.current = false;
      return;
    }
    if (!session) {
      localStorage.setItem("zimlo:last-workspace", workspaceId);
      localStorage.setItem("zimlo:last-provider", provider);
    }
    localStorage.removeItem(draftKey);
    onSubmitted?.();
    onClose();
  };

  const handleInputAction = () => {
    if (session) {
      submit();
      return;
    }
    if (!contentReady) return;
    setStep("agent");
  };

  const goBack = () => {
    if (step === "runtime") {
      setRuntimeConfirmed(false);
      setStep("agent");
    } else if (step === "agent") {
      setStep("input");
    }
  };

  const title = session
    ? "回复"
    : step === "input"
      ? "新任务"
      : step === "agent"
        ? "选择 Agent"
        : "选择执行方式";
  const stepNumber = step === "input" ? 1 : step === "agent" ? 2 : 3;
  const acceptsMaterials = Boolean(session || step === "input");

  return (
    <div className="composer-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <section className={`new-task-sheet ${session ? "is-follow-up" : `is-new-task is-step-${step}`}`} role="dialog" aria-modal="true" aria-labelledby="new-task-title" ref={sheetRef}
        onDragOver={(event) => { if (!acceptsMaterials) return; event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
        onDrop={(event) => { if (!acceptsMaterials) return; event.preventDefault(); void addFiles([...event.dataTransfer.files]); }}
        onPaste={(event) => {
          if (!acceptsMaterials) return;
          const files = [...event.clipboardData.files];
          if (files.length) { event.preventDefault(); void addFiles(files); }
        }}>
        {voiceNotice && <div className="composer-floating-notice" role="status">{voiceNotice}</div>}
        <header className="new-task-header">
          <div className="new-task-header-leading">
            {!session && step !== "input" && <button type="button" onClick={goBack} aria-label="返回上一步"><AppIcon name="arrow-left" /></button>}
            <h2 id="new-task-title">{title}</h2>
          </div>
          {!session && <div className="composer-step-progress" aria-label={`步骤 ${stepNumber}/3`}>
            {[1, 2, 3].map((item) => <span className={item <= stepNumber ? "is-active" : ""} key={item} />)}
          </div>}
          <button className="new-task-close" type="button" onClick={onClose} aria-label="关闭输入面板"><AppIcon name="close" /></button>
        </header>
        <div className="new-task-scroll">
          {session && <div className="composer-current-session">
            <AgentAvatar avatar={conversationAgent?.agentProfile.avatar ?? "●"} className={`composer-context-avatar ${conversationAgent ? agentAvatarStyle(conversationAgent.id) : ""}`} alt="" />
            <strong>{session.title}</strong>
            <ProviderBadge provider={session.provider} labelMode="icon" />
          </div>}
          {(session || step === "input") && <section className="composer-brief" aria-label={session ? "回复" : "任务内容"}>
            <div className="composer-input-row">
              <input ref={attachmentInput} type="file" multiple hidden accept="image/jpeg,image/png,image/webp,image/heic,image/heif,video/mp4,video/quicktime,video/x-m4v,application/pdf,text/plain,text/markdown,text/csv,application/json,.doc,.docx,.xls,.xlsx,.ppt,.pptx" onChange={(event) => { void addFiles([...event.target.files ?? []]); event.currentTarget.value = ""; }} />
              <button className="composer-attach-button" type="button" onClick={() => attachmentInput.current?.click()} disabled={materials.length >= 10} aria-label="添加附件" title="添加附件">
                <AppIcon name="paperclip" />
              </button>
              <VoiceInput compact singleLine value={text} onChange={setText} ariaLabel={session ? "回复" : "任务目标"} placeholder={session ? "输入回复…" : "描述目标…"} onSubmit={handleInputAction} onError={setVoiceNotice} />
              <button className="composer-send-button" type="button" onClick={handleInputAction} disabled={session ? !canSubmit : !contentReady} aria-label={session ? "发送消息" : "继续选择 Agent"} title={session ? "发送" : "下一步"}>
                <AppIcon name="arrow-up" />
              </button>
            </div>
            {materials.length > 0 && <div className="composer-input-hint"><span>附件</span><span>{materials.length}/10</span></div>}
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
          </section>}

          {!session && step === "agent" && <section className="composer-step-panel composer-agent-step" aria-label="选择 Agent">
            <label className="composer-project-search">
              <span aria-hidden="true">⌕</span>
              <input autoFocus value={projectQuery} onChange={(event) => setProjectQuery(event.target.value)} placeholder="搜索 Agent 或项目" aria-label="搜索 Agent" />
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
                    {selected && <span className="composer-selected-check" aria-hidden="true">✓</span>}
                  </button>
                );
              })}
              {visibleWorkspaces.length === 0 && <p className="composer-empty-search">没有匹配的 Agent</p>}
            </div>
            {workspaces.length === 0 && <p className="composer-warning">先在 Mac 的 Codex 或 Claude Code 中打开一次项目，Zimlo 才能安全地把任务交给它。</p>}
          </section>}

          {!session && step === "runtime" && <section className="composer-step-panel composer-runtime-step" aria-label="选择执行方式">
            <div className="composer-selected-agent">
              <AgentAvatar avatar={agentAvatar} className={`composer-agent-avatar ${selectedAgent ? agentAvatarStyle(selectedAgent.id) : ""}`} alt="" />
              <strong>{agentName}</strong>
            </div>
            <div className="composer-runtime-grid" role="radiogroup" aria-label="选择执行方式">
              {(["codex", "claude"] satisfies Provider[]).map((item) => {
                const selected = runtimeConfirmed && provider === item;
                return <button type="button" role="radio" aria-checked={selected} className={selected ? "selected" : ""} disabled={!availableProviders.includes(item)} onClick={() => { setProvider(item); setRuntimeConfirmed(true); }} key={item}>
                  <ProviderBadge provider={item} labelMode="icon" />
                  <span>{item === "codex" ? "Codex" : "Claude Code"}</span>
                  {selected && <span className="composer-selected-check" aria-hidden="true">✓</span>}
                </button>;
              })}
            </div>
            <button className="composer-final-submit" type="button" onClick={submit} disabled={!canSubmit}>
              <span>开始任务</span>
              <AppIcon name="arrow-up" />
            </button>
          </section>}

        </div>
      </section>
    </div>
  );
}
