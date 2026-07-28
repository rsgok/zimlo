import { useEffect, useMemo, useState } from "react";
import type { TaskCommand } from "@zimlo/protocol";
import { FeedView } from "./components/FeedView";
import { AppTopBar } from "./components/AppTopBar";
import { AppIcon } from "./components/AppIcon";
import { AgentProfileDetail } from "./components/AgentProfileDetail";
import { AgentsView } from "./components/AgentsView";
import { PairingRequired } from "./components/PairingRequired";
import { ProfileView } from "./components/ProfileView";
import { SessionDetail } from "./components/SessionDetail";
import { SystemNotices } from "./components/SystemNotices";
import { TasksView } from "./components/TasksView";
import { TaskComposer } from "./components/TaskComposer";
import { UserAvatar } from "./components/UserAvatar";
import { useBridge } from "./hooks/useBridge";

type Tab = "feed" | "tasks" | "agents" | "settings";

export function App() {
  const bridge = useBridge();
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  const [tab, setTab] = useState<Tab>("feed");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newTaskProjectId, setNewTaskProjectId] = useState<string | null>(null);
  const selectedSession = useMemo(
    () => bridge.snapshot.sessions.find((session) => session.id === selectedSessionId) ?? null,
    [bridge.snapshot.sessions, selectedSessionId],
  );
  const selectedProject = useMemo(
    () => bridge.snapshot.projects.find((project) => project.id === selectedProjectId) ?? null,
    [bridge.snapshot.projects, selectedProjectId],
  );
  const localTaskCommands = useMemo<TaskCommand[]>(() => bridge.pendingCommandEntries.flatMap(({ command, enqueuedAt }): TaskCommand[] => {
    if (command.type === "task.create") {
      const workspace = bridge.snapshot.workspaces.find((candidate) => candidate.id === command.workspaceId);
      return [{ id: `local:${command.idempotencyKey}`, idempotencyKey: command.idempotencyKey, kind: "create", provider: command.provider, sessionId: null, workspaceId: command.workspaceId, cwd: workspace?.path ?? "", text: command.text, state: "queued", createdAt: enqueuedAt, updatedAt: enqueuedAt }];
    }
    if (command.type === "task.follow_up" || command.type === "session.message") {
      const session = bridge.snapshot.sessions.find((candidate) => candidate.id === command.sessionId);
      if (!session) return [];
      return [{ id: `local:${command.idempotencyKey}`, idempotencyKey: command.idempotencyKey, kind: "follow_up", provider: session.provider, sessionId: session.id, workspaceId: null, cwd: session.cwd ?? "", text: command.text, state: "queued", createdAt: enqueuedAt, updatedAt: enqueuedAt }];
    }
    return [];
  }), [bridge.pendingCommandEntries, bridge.snapshot.sessions, bridge.snapshot.workspaces]);
  const commands = useMemo(() => [...localTaskCommands, ...bridge.snapshot.commands], [bridge.snapshot.commands, localTaskCommands]);
  const tabTitle: Record<Tab, string> = { feed: "Feed", tasks: "任务", agents: "Agents", settings: "设置" };

  useEffect(() => {
    if (!bridge.notice) return;
    const timer = window.setTimeout(bridge.dismissNotice, 4_000);
    return () => window.clearTimeout(timer);
  }, [bridge.notice, bridge.dismissNotice]);

  useEffect(() => {
    const updateNetwork = () => setOnline(navigator.onLine);
    const refreshAfterBackground = () => {
      updateNetwork();
      if (document.visibilityState === "visible" && bridge.connected) bridge.send({ type: "snapshot.request", afterSequence: bridge.snapshot.sequence });
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
  }, [bridge.connected, bridge.send, bridge.snapshot.sequence]);

  if (bridge.pairingRequired) return <PairingRequired error={bridge.error} />;

  const openSession = (sessionId: string) => {
    setSelectedSessionId(sessionId);
    bridge.send({ type: "session.events.request", sessionId });
  };
  const openAgent = (projectId: string) => setSelectedProjectId(projectId);
  const openNewTask = (projectId: string | null = null) => {
    setNewTaskProjectId(projectId);
    setNewTaskOpen(true);
  };
  const openSettings = () => {
    setTab("settings");
    if (bridge.localAdmin) bridge.send({ type: "devices.request" });
    if (bridge.localAdmin) bridge.send({ type: "codex.plugin.request" });
    if (bridge.localAdmin) bridge.send({ type: "integrations.request" });
  };

  return (
    <div className={`app-shell tab-${tab}`}>
      <AppTopBar title={tabTitle[tab]} connected={bridge.connected} online={online} connectionMode={bridge.connectionMode} />

      <SystemNotices online={online} pendingCount={bridge.pendingOutboxCount} error={bridge.error} />

      <main className={`main-content ${tab === "feed" ? "feed-main" : ""}`}>
        {tab === "feed" && <FeedView projects={bridge.snapshot.projects} posts={bridge.snapshot.posts} sessions={bridge.snapshot.sessions} actions={bridge.snapshot.actions} commands={commands} tasks={bridge.snapshot.tasks} reviews={bridge.snapshot.features.taskReview ? bridge.snapshot.reviews : []} seenPostIds={bridge.snapshot.seenPostIds} dismissedFeedItemIds={bridge.snapshot.dismissedFeedItemIds} send={bridge.send} onOpen={openSession} onOpenProject={openAgent} onNewTask={() => openNewTask()} />}
        {tab === "tasks" && <TasksView projects={bridge.snapshot.projects} sessions={bridge.snapshot.sessions} tasks={bridge.snapshot.tasks} posts={bridge.snapshot.posts} preferences={bridge.snapshot.taskPreferences} send={bridge.send} onOpen={openSession} />}
        {tab === "agents" && <AgentsView projects={bridge.snapshot.projects} sessions={bridge.snapshot.sessions} onOpen={openAgent} onNewTask={openNewTask} />}
        {tab === "settings" && (
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
            send={bridge.send}
            forgetDevice={bridge.forgetDevice}
          />
        )}
      </main>

      <nav className="bottom-nav" aria-label="主导航">
        <button aria-current={tab === "feed" ? "page" : undefined} className={tab === "feed" ? "active" : ""} onClick={() => setTab("feed")}>
          <span className="bottom-nav-icon"><AppIcon name="feed" /></span>
          <span className="bottom-nav-label">Feed</span>
        </button>
        <button aria-current={tab === "tasks" ? "page" : undefined} className={tab === "tasks" ? "active" : ""} onClick={() => setTab("tasks")}>
          <span className="bottom-nav-icon"><AppIcon name="tasks" /></span>
          <span className="bottom-nav-label">Tasks</span>
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
        <button aria-current={tab === "agents" ? "page" : undefined} className={tab === "agents" ? "active" : ""} onClick={() => setTab("agents")}>
          <span className="bottom-nav-icon"><AppIcon name="agents" /></span>
          <span className="bottom-nav-label">Agents</span>
        </button>
        <button aria-current={tab === "settings" ? "page" : undefined} className={tab === "settings" ? "active" : ""} onClick={openSettings} aria-label="个人设置">
          <span className="bottom-nav-icon bottom-nav-user"><UserAvatar avatarId={bridge.snapshot.userProfile.avatarId} className="bottom-nav-avatar" alt="" /></span>
          <span className="bottom-nav-label">设置</span>
        </button>
      </nav>

      {bridge.notice && <div className="toast" role="status">{bridge.notice}</div>}
      {selectedProject && (
        <AgentProfileDetail
          project={selectedProject}
          sessions={bridge.snapshot.sessions.filter((session) => session.projectId === selectedProject.id)}
          posts={bridge.snapshot.posts.filter((post) => post.projectId === selectedProject.id)}
          commands={commands}
          trustPolicy={bridge.snapshot.trustPolicies.find((policy) => policy.projectId === selectedProject.id)}
          trustAudit={bridge.snapshot.trustAudit.filter((entry) => entry.projectId === selectedProject.id)}
          trustEnabled={bridge.snapshot.features.projectTrustPolicy}
          userAvatarId={bridge.snapshot.userProfile.avatarId}
          send={bridge.send}
          onOpenTask={openSession}
          onNewTask={openNewTask}
          onClose={() => setSelectedProjectId(null)}
        />
      )}
      {selectedSession && (
        <SessionDetail
          session={selectedSession}
          project={bridge.snapshot.projects.find((project) => project.id === selectedSession.projectId)}
          events={bridge.events[selectedSession.id] ?? []}
          actions={bridge.snapshot.actions.filter((action) => action.sessionId === selectedSession.id)}
          posts={bridge.snapshot.posts.filter((post) => post.sessionId === selectedSession.id)}
          commands={commands.filter((command) => command.sessionId === selectedSession.id)}
          task={[...bridge.snapshot.tasks].filter((task) => task.sessionId === selectedSession.id).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]}
          reviews={bridge.snapshot.features.taskReview ? bridge.snapshot.reviews.filter((review) => review.sessionId === selectedSession.id) : []}
          userAvatarId={bridge.snapshot.userProfile.avatarId}
          timelineCursor={bridge.snapshot.taskTimelineCursors[selectedSession.id]}
          send={bridge.send}
          onClose={() => setSelectedSessionId(null)}
        />
      )}
      {newTaskOpen && <TaskComposer workspaces={bridge.snapshot.workspaces} projects={bridge.snapshot.projects} initialProjectId={newTaskProjectId} send={bridge.send} onSubmitted={() => setTab("feed")} onClose={() => { setNewTaskOpen(false); setNewTaskProjectId(null); }} />}
    </div>
  );
}
