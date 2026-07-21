import { useEffect, useMemo, useState } from "react";
import { FeedView } from "./components/FeedView";
import { PairingRequired } from "./components/PairingRequired";
import { ProfileView } from "./components/ProfileView";
import { SessionDetail } from "./components/SessionDetail";
import { TasksView } from "./components/TasksView";
import { useBridge } from "./hooks/useBridge";

type Tab = "feed" | "tasks" | "profile";

export function App() {
  const bridge = useBridge();
  const [tab, setTab] = useState<Tab>("feed");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const selectedSession = useMemo(
    () => bridge.snapshot.sessions.find((session) => session.id === selectedSessionId) ?? null,
    [bridge.snapshot.sessions, selectedSessionId],
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

  return (
    <div className={`app-shell tab-${tab}`}>
      <header className="app-header">
        <div className="brand-lockup">
          <span className="brand-mark">Z</span>
          <div><strong>Zimlo</strong><small>coding agents, at a glance</small></div>
        </div>
        <div className={`connection-pill ${bridge.connected ? "connected" : ""}`}>
          <span />{bridge.connected ? "实时" : "重连中"}
        </div>
      </header>

      <main className={`main-content ${tab === "feed" ? "feed-main" : ""}`}>
        {bridge.error && <div className="error-banner">{bridge.error}</div>}
        {tab === "feed" && <FeedView posts={bridge.snapshot.posts} sessions={bridge.snapshot.sessions} actions={bridge.snapshot.actions} send={bridge.send} onOpen={openSession} />}
        {tab === "tasks" && <TasksView sessions={bridge.snapshot.sessions} onOpen={openSession} />}
        {tab === "profile" && (
          <ProfileView
            localAdmin={bridge.localAdmin}
            devices={bridge.devices}
            pairing={bridge.pairing}
            codexPlugin={bridge.codexPlugin}
            lanApprovalsEnabled={bridge.snapshot.lanApprovalsEnabled}
            send={bridge.send}
            forgetDevice={bridge.forgetDevice}
          />
        )}
      </main>

      <nav className="bottom-nav" aria-label="主导航">
        <button aria-current={tab === "feed" ? "page" : undefined} className={tab === "feed" ? "active" : ""} onClick={() => setTab("feed")}><span>◫</span>Feed</button>
        <button aria-current={tab === "tasks" ? "page" : undefined} className={tab === "tasks" ? "active" : ""} onClick={() => setTab("tasks")}><span>◎</span>Tasks</button>
        <button aria-current={tab === "profile" ? "page" : undefined} className={tab === "profile" ? "active" : ""} onClick={() => {
          setTab("profile");
          if (bridge.localAdmin) bridge.send({ type: "devices.request" });
          if (bridge.localAdmin) bridge.send({ type: "codex.plugin.request" });
        }}><span>◇</span>Profile</button>
      </nav>

      {bridge.notice && <div className="toast" role="status">{bridge.notice}</div>}
      {selectedSession && (
        <SessionDetail
          session={selectedSession}
          events={bridge.events[selectedSession.id] ?? []}
          actions={bridge.snapshot.actions.filter((action) => action.sessionId === selectedSession.id)}
          posts={bridge.snapshot.posts.filter((post) => post.sessionId === selectedSession.id)}
          send={bridge.send}
          onClose={() => setSelectedSessionId(null)}
        />
      )}
    </div>
  );
}
