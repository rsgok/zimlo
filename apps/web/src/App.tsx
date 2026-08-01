import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TaskCommand } from "@zimlo/protocol";
import { FeedView } from "./components/FeedView";
import { AppTopBar } from "./components/AppTopBar";
import { AppIcon } from "./components/AppIcon";
import { AgentProfileDetail } from "./components/AgentProfileDetail";
import { AgentsView } from "./components/AgentsView";
import { OutboxSheet, restoreDraftForEntry } from "./components/OutboxSheet";
import { PairingRequired } from "./components/PairingRequired";
import { ProfileView } from "./components/ProfileView";
import { SessionDetail } from "./components/SessionDetail";
import { SystemNotices } from "./components/SystemNotices";
import { TasksView } from "./components/TasksView";
import { TaskComposer } from "./components/TaskComposer";
import { UndoToast, type UndoToastData } from "./components/UndoToast";
import { UserAvatar } from "./components/UserAvatar";
import { useBridge } from "./hooks/useBridge";

type Tab = "feed" | "tasks" | "agents" | "settings";

const TAB_TITLES: Record<Tab, string> = { feed: "动态", tasks: "任务", agents: "Agents", settings: "设置" };

export function App() {
  const bridge = useBridge();
  const { send } = bridge;
  const macosShell = typeof document !== "undefined" && document.documentElement.dataset.zimloShell === "macos";
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  const [tab, setTab] = useState<Tab>("feed");
  // 已挂载的 tab 保持存活：切走再切回时列表滚动位置、Feed 队列状态都不丢。
  const [mountedTabs, setMountedTabs] = useState<ReadonlySet<Tab>>(() => new Set<Tab>(["feed"]));
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newTaskProjectId, setNewTaskProjectId] = useState<string | null>(null);
  const [outboxOpen, setOutboxOpen] = useState(false);
  const [undoToast, setUndoToast] = useState<UndoToastData | null>(null);
  const scrollPositionsRef = useRef<Partial<Record<Tab, number>>>({});
  const selectedSession = useMemo(
    () => bridge.snapshot.sessions.find((session) => session.id === selectedSessionId) ?? null,
    [bridge.snapshot.sessions, selectedSessionId],
  );
  const selectedProject = useMemo(
    () => bridge.snapshot.projects.find((project) => project.id === selectedProjectId) ?? null,
    [bridge.snapshot.projects, selectedProjectId],
  );
  const localTaskCommands = useMemo<TaskCommand[]>(() => bridge.pendingCommandEntries.flatMap(({ command, enqueuedAt, state }): TaskCommand[] => {
    const localState = state === "failed" ? "failed" : "queued";
    if (command.type === "task.create") {
      const workspace = bridge.snapshot.workspaces.find((candidate) => candidate.id === command.workspaceId);
      return [{ id: `local:${command.idempotencyKey}`, idempotencyKey: command.idempotencyKey, kind: "create", provider: command.provider, sessionId: null, workspaceId: command.workspaceId, cwd: workspace?.path ?? "", text: command.text, state: localState, createdAt: enqueuedAt, updatedAt: enqueuedAt }];
    }
    if (command.type === "task.follow_up" || command.type === "session.message") {
      const session = bridge.snapshot.sessions.find((candidate) => candidate.id === command.sessionId);
      if (!session) return [];
      return [{ id: `local:${command.idempotencyKey}`, idempotencyKey: command.idempotencyKey, kind: "follow_up", provider: session.provider, sessionId: session.id, workspaceId: null, cwd: session.cwd ?? "", text: command.text, state: localState, createdAt: enqueuedAt, updatedAt: enqueuedAt }];
    }
    return [];
  }), [bridge.pendingCommandEntries, bridge.snapshot.sessions, bridge.snapshot.workspaces]);
  const commands = useMemo(() => [...localTaskCommands, ...bridge.snapshot.commands], [bridge.snapshot.commands, localTaskCommands]);

  const mountTab = useCallback((next: Tab) => {
    setTab(next);
    setMountedTabs((current) => current.has(next) ? current : new Set(current).add(next));
  }, []);

  const openSession = useCallback((sessionId: string) => {
    setSelectedSessionId(sessionId);
    send({ type: "session.events.request", sessionId });
  }, [send]);
  const openAgent = useCallback((projectId: string) => setSelectedProjectId(projectId), []);
  const openNewTask = useCallback((projectId: string | null = null) => {
    setNewTaskProjectId(projectId);
    setNewTaskOpen(true);
  }, []);
  const openSettings = useCallback(() => {
    mountTab("settings");
    if (bridge.localAdmin) send({ type: "devices.request" });
    if (bridge.localAdmin) send({ type: "codex.plugin.request" });
    if (bridge.localAdmin) send({ type: "integrations.request" });
  }, [bridge.localAdmin, mountTab, send]);
  const showUndo = useCallback((label: string, undo: () => void) => {
    setUndoToast({ id: Date.now(), label, undo });
  }, []);
  const closeUndoToast = useCallback((id: number) => {
    setUndoToast((current) => (current?.id === id ? null : current));
  }, []);
  const openOutbox = useCallback(() => setOutboxOpen(true), []);

  useEffect(() => {
    if (!bridge.notice) return;
    const timer = window.setTimeout(bridge.dismissNotice, 4_000);
    return () => window.clearTimeout(timer);
  }, [bridge.notice, bridge.dismissNotice]);

  useEffect(() => {
    const updateNetwork = () => setOnline(navigator.onLine);
    const refreshAfterBackground = () => {
      updateNetwork();
      if (document.visibilityState === "visible" && bridge.connected) send({ type: "snapshot.request", afterSequence: bridge.snapshot.sequence });
    };
    window.addEventListener("online", updateNetwork);
    window.addEventListener("offline", updateNetwork);
    window.addEventListener("pageshow", refreshAfterBackground);
    document.addEventListener("visibilitychange", refreshAfterBackground);
    return () => {
      window.removeEventListener("online", updateNetwork);
      window.removeEventListener("offline", updateNetwork);
      window.removeEventListener("pageshow", refreshAfterBackground);
      document.removeEventListener("visibilitychange", refreshAfterBackground);
    };
  }, [bridge.connected, send, bridge.snapshot.sequence]);

  // 记住各 tab 的窗口滚动位置（Feed 自己管滚动，跳过）。
  const previousTabRef = useRef<Tab>(tab);
  useEffect(() => {
    const previous = previousTabRef.current;
    if (previous === tab) return;
    scrollPositionsRef.current[previous] = window.scrollY;
    previousTabRef.current = tab;
    if (tab === "feed") return;
    window.scrollTo(0, scrollPositionsRef.current[tab] ?? 0);
  }, [tab]);

  if (bridge.pairingRequired) return <PairingRequired error={bridge.error} />;

  return (
    <div className={`app-shell tab-${tab}${macosShell ? " is-macos-shell" : ""}`}>
      {!macosShell && (
        <AppTopBar
          title={TAB_TITLES[tab]}
          connected={bridge.connected}
          online={online}
          connectionMode={bridge.connectionMode}
          reconnectAttempt={bridge.reconnectAttempt}
          reconnectPausedOffline={bridge.reconnectPausedOffline}
          onRetryReconnect={bridge.retryReconnectNow}
        />
      )}

      <SystemNotices
        online={online}
        pendingCount={bridge.pendingOutboxCount}
        error={bridge.error}
        connected={bridge.connected}
        snapshotSavedAt={bridge.snapshotSavedAt}
        onDismissError={bridge.dismissError}
        onShowOutbox={openOutbox}
      />

      <main className={`main-content ${tab === "feed" ? "feed-main" : ""}`}>
        <div className={tab === "feed" ? "tab-panel" : "tab-panel tab-panel-hidden"}>
          {mountedTabs.has("feed") && <FeedView projects={bridge.snapshot.projects} posts={bridge.snapshot.posts} materials={bridge.snapshot.materials} sessions={bridge.snapshot.sessions} actions={bridge.snapshot.actions} commands={commands} tasks={bridge.snapshot.tasks} reviews={bridge.snapshot.features.taskReview ? bridge.snapshot.reviews : []} seenPostIds={bridge.snapshot.seenPostIds} dismissedFeedItemIds={bridge.snapshot.dismissedFeedItemIds} send={send} onOpen={openSession} onOpenProject={openAgent} onNewTask={() => openNewTask()} onRequestUndo={showUndo} interactionMode={macosShell ? "desktop" : "swipe"} />}
        </div>
        <div className={tab === "tasks" ? "tab-panel" : "tab-panel tab-panel-hidden"}>
          {mountedTabs.has("tasks") && <TasksView projects={bridge.snapshot.projects} sessions={bridge.snapshot.sessions} tasks={bridge.snapshot.tasks} posts={bridge.snapshot.posts} preferences={bridge.snapshot.taskPreferences} send={send} onOpen={openSession} onRequestUndo={showUndo} />}
        </div>
        <div className={tab === "agents" ? "tab-panel" : "tab-panel tab-panel-hidden"}>
          {mountedTabs.has("agents") && <AgentsView projects={bridge.snapshot.projects} sessions={bridge.snapshot.sessions} onOpen={openAgent} onNewTask={openNewTask} />}
        </div>
        <div className={tab === "settings" ? "tab-panel" : "tab-panel tab-panel-hidden"}>
          {mountedTabs.has("settings") && (
            <ProfileView
              localAdmin={bridge.localAdmin}
              devices={bridge.devices}
              pairing={bridge.pairing}
              codexPlugin={bridge.codexPlugin}
              integrations={bridge.integrations}
              sessions={bridge.snapshot.sessions}
              userProfile={bridge.snapshot.userProfile}
              lanApprovalsEnabled={bridge.snapshot.lanApprovalsEnabled}
              notificationSettings={bridge.snapshot.notificationSettings}
              pushRegistered={bridge.snapshot.pushDevices.some((device) => device.active)}
              notificationEnabled={bridge.snapshot.features.pushNotifications}
              connected={bridge.connected}
              connectionMode={bridge.connectionMode}
              send={send}
              forgetDevice={bridge.forgetDevice}
            />
          )}
        </div>
      </main>

      <nav className="bottom-nav" aria-label="主导航">
        <button aria-current={tab === "feed" ? "page" : undefined} className={tab === "feed" ? "active" : ""} onClick={() => mountTab("feed")}>
          <span className="bottom-nav-icon"><AppIcon name="feed" /></span>
          <span className="bottom-nav-label">动态</span>
        </button>
        <button aria-current={tab === "tasks" ? "page" : undefined} className={tab === "tasks" ? "active" : ""} onClick={() => mountTab("tasks")}>
          <span className="bottom-nav-icon"><AppIcon name="tasks" /></span>
          <span className="bottom-nav-label">任务</span>
        </button>
        <button
          className={`new-task-nav ${newTaskOpen ? "active" : ""}`}
          aria-pressed={newTaskOpen}
          onClick={() => openNewTask()}
          aria-label="布置新任务"
        >
          <span className="bottom-nav-icon bottom-nav-create"><AppIcon name="plus" /></span>
          <strong className="bottom-nav-label">新任务</strong>
        </button>
        <button aria-current={tab === "agents" ? "page" : undefined} className={tab === "agents" ? "active" : ""} onClick={() => mountTab("agents")}>
          <span className="bottom-nav-icon"><AppIcon name="agents" /></span>
          <span className="bottom-nav-label">Agents</span>
        </button>
        <button aria-current={tab === "settings" ? "page" : undefined} className={tab === "settings" ? "active" : ""} onClick={openSettings} aria-label="个人设置">
          <span className="bottom-nav-icon bottom-nav-user"><UserAvatar avatarId={bridge.snapshot.userProfile.avatarId} className="bottom-nav-avatar" alt="" /></span>
          <span className="bottom-nav-label">设置</span>
        </button>
      </nav>

      {bridge.notice && <div className="toast" role="status">{bridge.notice}</div>}
      <UndoToast toast={undoToast} onClose={closeUndoToast} />
      {outboxOpen && (
        <OutboxSheet
          entries={bridge.pendingCommandEntries}
          sessions={bridge.snapshot.sessions}
          workspaces={bridge.snapshot.workspaces}
          onCancelEntry={(entryId) => { bridge.cancelOutboxEntry(entryId); }}
          onRetryEntry={(entryId) => { bridge.retryOutboxEntry(entryId); }}
          onReeditEntry={(entryId) => {
            const entry = bridge.pendingCommandEntries.find((candidate) => candidate.id === entryId);
            if (entry && restoreDraftForEntry(entry)) {
              bridge.removeOutboxEntry(entryId);
              setOutboxOpen(false);
            }
          }}
          onRemoveEntry={bridge.removeOutboxEntry}
          onClose={() => setOutboxOpen(false)}
        />
      )}
      {selectedProject && (
        <AgentProfileDetail
          key={selectedProject.id}
          project={selectedProject}
          sessions={bridge.snapshot.sessions.filter((session) => session.projectId === selectedProject.id)}
          posts={bridge.snapshot.posts.filter((post) => post.projectId === selectedProject.id)}
          commands={commands}
          trustPolicy={bridge.snapshot.trustPolicies.find((policy) => policy.projectId === selectedProject.id)}
          trustAudit={bridge.snapshot.trustAudit.filter((entry) => entry.projectId === selectedProject.id)}
          trustEnabled={bridge.snapshot.features.projectTrustPolicy}
          userAvatarId={bridge.snapshot.userProfile.avatarId}
          send={send}
          onOpenTask={openSession}
          onNewTask={openNewTask}
          onClose={() => setSelectedProjectId(null)}
        />
      )}
      {selectedSession && (
        <SessionDetail
          key={selectedSession.id}
          session={selectedSession}
          project={bridge.snapshot.projects.find((project) => project.id === selectedSession.projectId)}
          events={bridge.events[selectedSession.id] ?? []}
          actions={bridge.snapshot.actions.filter((action) => action.sessionId === selectedSession.id)}
          posts={bridge.snapshot.posts.filter((post) => post.sessionId === selectedSession.id)}
          commands={commands.filter((command) => command.sessionId === selectedSession.id)}
          materials={bridge.snapshot.materials}
          task={[...bridge.snapshot.tasks].filter((task) => task.sessionId === selectedSession.id).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]}
          reviews={bridge.snapshot.features.taskReview ? bridge.snapshot.reviews.filter((review) => review.sessionId === selectedSession.id) : []}
          userAvatarId={bridge.snapshot.userProfile.avatarId}
          timelineCursor={bridge.snapshot.taskTimelineCursors[selectedSession.id]}
          send={send}
          onRetryLocal={(commandId) => { bridge.retryOutboxEntry(commandId.slice("local:".length)); }}
          onClose={() => setSelectedSessionId(null)}
        />
      )}
      {newTaskOpen && <TaskComposer workspaces={bridge.snapshot.workspaces} projects={bridge.snapshot.projects} initialProjectId={newTaskProjectId} send={send} onSubmitted={() => mountTab("feed")} onClose={() => { setNewTaskOpen(false); setNewTaskProjectId(null); }} />}
    </div>
  );
}
