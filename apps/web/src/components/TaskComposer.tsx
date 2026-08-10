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
  const dragStartY = useRef<number | null>(null);
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
    setChoosingAgent(false);
  };

  const contentReady = Boolean(text.trim() && materials.every((item) => item.state === "ready"));
  const canSubmit = session
    ? contentReady
    : Boolean(workspaceId && contentReady && availableProviders.includes(provider));
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

  const title = session ? "回复" : "新任务";
  const resetSheetDrag = () => {
    dragStartY.current = null;
    const sheet = sheetRef.current;
    if (!sheet) return;
    sheet.style.transition = "transform 180ms ease-out";
    sheet.style.transform = "translateY(0)";
    window.setTimeout(() => {
      if (sheetRef.current !== sheet) return;
      sheet.style.removeProperty("transform");
      sheet.style.removeProperty("transition");
    }, 190);
  };
  const finishSheetDrag = (clientY: number) => {
    const start = dragStartY.current;
    if (start === null) return;
    const distance = clientY - start;
    if (distance > 86) {
      onClose();
      return;
    }
    resetSheetDrag();
  };

  return (
    <div className="composer-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <section className={`new-task-sheet ${session ? "is-follow-up" : "is-new-task"}`} role="dialog" aria-modal="true" aria-labelledby="new-task-title" ref={sheetRef}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
        onDrop={(event) => { event.preventDefault(); void addFiles([...event.dataTransfer.files]); }}
        onPaste={(event) => {
          const files = [...event.clipboardData.files];
          if (files.length) { event.preventDefault(); void addFiles(files); }
        }}>
        {voiceNotice && <div className="composer-floating-notice" role="status">{voiceNotice}</div>}
        <header className="new-task-header"
          onPointerDown={(event) => { dragStartY.current = event.clientY; sheetRef.current?.style.removeProperty("transition"); event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={(event) => {
            const start = dragStartY.current;
            if (start === null || !sheetRef.current) return;
            sheetRef.current.style.transform = `translateY(${Math.max(0, event.clientY - start)}px)`;
          }}
          onPointerUp={(event) => finishSheetDrag(event.clientY)}
          onPointerCancel={resetSheetDrag}>
          <span className="new-task-grabber" aria-hidden="true" />
          <h2 id="new-task-title">{title}</h2>
        </header>
        <div className="new-task-scroll">
          {session && <div className="composer-current-session">
            <AgentAvatar avatar={conversationAgent?.agentProfile.avatar ?? "●"} className={`composer-context-avatar ${conversationAgent ? agentAvatarStyle(conversationAgent.id) : ""}`} alt="" />
            <strong>{session.title}</strong>
            <ProviderBadge provider={session.provider} labelMode="icon" />
          </div>}
          <section className="composer-brief" aria-label={session ? "回复" : "任务内容"}>
            {!session && <div className="composer-field-heading"><strong>任务内容</strong><span>{text.trim() ? "草稿已保存" : "草稿自动保存"}</span></div>}
            <div className="composer-input-row">
              <input ref={attachmentInput} type="file" multiple hidden accept="image/jpeg,image/png,image/webp,image/heic,image/heif,video/mp4,video/quicktime,video/x-m4v,application/pdf,text/plain,text/markdown,text/csv,application/json,.doc,.docx,.xls,.xlsx,.ppt,.pptx" onChange={(event) => { void addFiles([...event.target.files ?? []]); event.currentTarget.value = ""; }} />
              <button className="composer-attach-button" type="button" onClick={() => attachmentInput.current?.click()} disabled={materials.length >= 10} aria-label="添加附件" title="添加附件">
                <AppIcon name="paperclip" />
              </button>
              <VoiceInput compact singleLine value={text} onChange={setText} ariaLabel={session ? "回复" : "任务目标"} placeholder={session ? "输入回复…" : "描述目标，或点按麦克风…"} onSubmit={submit} onError={setVoiceNotice} />
              <button className="composer-send-button" type="button" onClick={submit} disabled={!canSubmit} aria-label={session ? "发送消息" : "开始任务"} title={session ? "发送" : "开始任务"}>
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
          </section>

          {!session && <section className="composer-destination" aria-label="交给谁">
            <div className="composer-field-heading"><strong>交给谁</strong><span>已沿用最近选择</span></div>
            <button className="composer-agent-summary" type="button" onClick={() => setChoosingAgent((current) => !current)} disabled={workspaces.length === 0} aria-expanded={choosingAgent}>
              <AgentAvatar avatar={agentAvatar} className={`composer-agent-avatar ${selectedAgent ? agentAvatarStyle(selectedAgent.id) : ""}`} alt="" />
              <span className="composer-agent-summary-copy"><strong>{agentName}</strong><small>{selectedAgent ? `${selectedAgent.name} · 已记住项目上下文` : selectedWorkspace?.label ?? "暂无可信项目"}</small></span>
              <ProviderBadge provider={provider} labelMode="icon" />
              <span className="composer-agent-change">{choosingAgent ? "收起" : "更换"}</span>
            </button>
            {choosingAgent && <div className="composer-agent-picker">
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
              <div className="composer-runtime-inline" role="radiogroup" aria-label="执行方式">
                <span>执行方式</span>
              {(["codex", "claude"] satisfies Provider[]).map((item) => {
                const selected = provider === item;
                return <button type="button" role="radio" aria-checked={selected} className={selected ? "selected" : ""} disabled={!availableProviders.includes(item)} onClick={() => setProvider(item)} key={item}>
                  <ProviderBadge provider={item} labelMode="icon" />
                  <span>{item === "codex" ? "Codex" : "Claude Code"}</span>
                  {selected && <span className="composer-selected-check" aria-hidden="true">✓</span>}
                </button>;
              })}
              </div>
            </div>}
            {workspaces.length === 0 && <p className="composer-warning">先在 Mac 的 Codex 或 Claude Code 中打开一次项目，Zimlo 才能安全地把任务交给它。</p>}
          </section>}

        </div>
      </section>
    </div>
  );
}
