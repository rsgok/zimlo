import { useEffect, useMemo, useState } from "react";
import { FeedView } from "./components/FeedView";
import { AgentProfileDetail } from "./components/AgentProfileDetail";
import { AgentsView } from "./components/AgentsView";
import { PairingRequired } from "./components/PairingRequired";
import { ProfileView } from "./components/ProfileView";
import { SessionDetail } from "./components/SessionDetail";
import { TasksView } from "./components/TasksView";
import { TaskComposer } from "./components/TaskComposer";
import { useBridge } from "./hooks/useBridge";

type Tab = "feed" | "tasks" | "agents" | "settings";

export function App() {
  const bridge = useBridge();
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

  useEffect(() => {
    if (!bridge.notice) return;
    const timer = window.setTimeout(bridge.dismissNotice, 4_000);
    return () => window.clearTimeout(timer);
  }, [bridge.notice, bridge.dismissNotice]);

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
      <header className="app-header">
        <div className="brand-lockup">
          <span className="brand-mark">Z</span>
          <div><strong>Zimlo</strong><small>coding agents, at a glance</small></div>
        </div>
        <div className="header-actions">
          <div className={`connection-pill ${bridge.connected ? "connected" : ""}`}><span />{bridge.connected ? "实时" : "重连中"}</div>
          <button className={`settings-button ${tab === "settings" ? "active" : ""}`} onClick={openSettings} aria-label="打开设置">⚙</button>
        </div>
      </header>

      <main className={`main-content ${tab === "feed" ? "feed-main" : ""}`}>
        {bridge.error && <div className="error-banner">{bridge.error}</div>}
        {tab === "feed" && <FeedView projects={bridge.snapshot.projects} posts={bridge.snapshot.posts} sessions={bridge.snapshot.sessions} actions={bridge.snapshot.actions} commands={bridge.snapshot.commands} seenPostIds={bridge.snapshot.seenPostIds} dismissedFeedItemIds={bridge.snapshot.dismissedFeedItemIds} send={bridge.send} onOpen={openSession} onOpenProject={openAgent} onNewTask={() => openNewTask()} />}
        {tab === "tasks" && <TasksView projects={bridge.snapshot.projects} sessions={bridge.snapshot.sessions} tasks={bridge.snapshot.tasks} onOpen={openSession} />}
        {tab === "agents" && <AgentsView projects={bridge.snapshot.projects} sessions={bridge.snapshot.sessions} onOpen={openAgent} onNewTask={openNewTask} />}
        {tab === "settings" && (
          <ProfileView
            localAdmin={bridge.localAdmin}
            devices={bridge.devices}
            pairing={bridge.pairing}
            codexPlugin={bridge.codexPlugin}
            integrations={bridge.integrations}
            sessions={bridge.snapshot.sessions}
            lanApprovalsEnabled={bridge.snapshot.lanApprovalsEnabled}
            send={bridge.send}
            forgetDevice={bridge.forgetDevice}
          />
        )}
      </main>

      <nav className="bottom-nav" aria-label="主导航">
        <button aria-current={tab === "feed" ? "page" : undefined} className={tab === "feed" ? "active" : ""} onClick={() => setTab("feed")}><span>◫</span>Feed</button>
        <button aria-current={tab === "tasks" ? "page" : undefined} className={tab === "tasks" ? "active" : ""} onClick={() => setTab("tasks")}><span>◎</span>Tasks</button>
        <button
          className={`new-task-nav ${newTaskOpen ? "active" : ""}`}
          aria-pressed={newTaskOpen}
          onClick={() => openNewTask()}
          aria-label="布置新任务"
        ><span>＋</span><strong>新任务</strong></button>
        <button aria-current={tab === "agents" ? "page" : undefined} className={tab === "agents" ? "active" : ""} onClick={() => setTab("agents")}><span>◉</span>Agents</button>
      </nav>

      {bridge.notice && <div className="toast" role="status">{bridge.notice}</div>}
      {selectedProject && (
        <AgentProfileDetail
          project={selectedProject}
          sessions={bridge.snapshot.sessions.filter((session) => session.projectId === selectedProject.id)}
          posts={bridge.snapshot.posts.filter((post) => post.projectId === selectedProject.id)}
          commands={bridge.snapshot.commands}
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
          commands={bridge.snapshot.commands.filter((command) => command.sessionId === selectedSession.id)}
          timelineCursor={bridge.snapshot.taskTimelineCursors[selectedSession.id]}
          send={bridge.send}
          onClose={() => setSelectedSessionId(null)}
        />
      )}
      {newTaskOpen && <TaskComposer workspaces={bridge.snapshot.workspaces} projects={bridge.snapshot.projects} initialProjectId={newTaskProjectId} send={bridge.send} onClose={() => { setNewTaskOpen(false); setNewTaskProjectId(null); }} />}
    </div>
  );
}
