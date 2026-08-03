"use client";

import { useState } from "react";

type ScreenKind = "feed" | "profile" | "artifacts" | "create" | "tasks" | "reliable";

const artifactTypes = [
  { id: "images", label: "Image album", meta: "4 images" },
  { id: "video", label: "Inline video", meta: "01:24" },
  { id: "document", label: "Markdown + text", meta: "Readable" },
  { id: "pdf", label: "PDF + files", meta: "Quick Look" },
] as const;

const tourItems: Array<{ id: ScreenKind; label: string; title: string; body: string; facts: string[] }> = [
  {
    id: "feed",
    label: "Attention Feed",
    title: "Swipe through changed reality.",
    body: "A vertical, one-card-at-a-time Feed for results, decisions, failures, approvals, and rich outputs.",
    facts: ["Editorial cards—not logs", "Unread and caught-up states", "Swipe into the source task"],
  },
  {
    id: "profile",
    label: "Task Profile",
    title: "Every session gets a living profile.",
    body: "Task input, latest conclusion, current ask, pending approvals, and the whole human–Agent conversation stay together.",
    facts: ["X-style session timeline", "Execution details on demand", "Reply in the same context"],
  },
  {
    id: "artifacts",
    label: "Artifacts",
    title: "Open the thing the Agent made.",
    body: "Browse images, play video, read Markdown and PDFs, or open source files without losing the task that produced them.",
    facts: ["Albums and full-bleed media", "Inline document readers", "Encrypted on-device cache"],
  },
  {
    id: "create",
    label: "Create + reply",
    title: "Brief an Agent from anywhere.",
    body: "Start a task or continue the current session with voice, text, photos, video, PDFs, and working files.",
    facts: ["Draft recovery", "Choose project and runtime", "Up to 10 attachments"],
  },
  {
    id: "tasks",
    label: "Tasks + Agents",
    title: "Find work by what needs you next.",
    body: "Search, filter, pin, archive, and resume tasks. Jump into project Agents with their own runtime and workspace context.",
    facts: ["Needs you / working / resumable", "Codex + Claude Code", "Project-scoped Agent profiles"],
  },
  {
    id: "reliable",
    label: "Reliable control",
    title: "Every tap survives the real world.",
    body: "Replies, approvals, settings, and retries persist through weak networks, app exits, reconnects, and repeated taps.",
    facts: ["Persistent outbox", "Idempotent commands", "End-to-end encryption"],
  },
];

function StatusBar() {
  return (
    <div className="ios-statusbar" aria-hidden="true">
      <strong>9:41</strong>
      <span><i /><i /><i /><b /></span>
    </div>
  );
}

function BottomNav({ active = "feed" }: { active?: "feed" | "tasks" | "agents" }) {
  return (
    <div className="ios-bottom-nav" aria-hidden="true">
      <span className={active === "feed" ? "active" : ""}><i>▱</i>Feed</span>
      <span className={active === "tasks" ? "active" : ""}><i>☷</i>Tasks</span>
      <b>↗</b>
      <span className={active === "agents" ? "active" : ""}><i>●●</i>Agents</span>
      <span><i>◉</i>You</span>
    </div>
  );
}

function PhoneShell({ children, label, className = "" }: { children: React.ReactNode; label: string; className?: string }) {
  return (
    <div className={`ios-phone ${className}`} aria-label={label}>
      <div className="ios-phone-frame">
        <div className="ios-dynamic-island" aria-hidden="true" />
        <StatusBar />
        <div className="ios-screen">{children}</div>
      </div>
    </div>
  );
}

function FeedScreen({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`ios-feed-screen${compact ? " ios-feed-screen--compact" : ""}`}>
      <div className="ios-feed-media" aria-hidden="true">
        <div className="ios-feed-orb" />
        <div className="ios-feed-grid" />
        <span className="ios-video-pill">▶ 01:24</span>
        <div className="ios-feed-artifact-stack"><i>PNG</i><i>PDF</i><i>ZIP</i></div>
      </div>
      <div className="ios-feed-top">
        <span className="ios-agent-avatar">Z</span>
        <div><strong>Zimlo Agent</strong><small>Codex · MacBook Pro · now</small></div>
      </div>
      <div className="ios-feed-actions" aria-hidden="true">
        <span><i>✓</i><small>Proof</small></span>
        <span><i>↗</i><small>Task</small></span>
        <span><i>···</i></span>
      </div>
      <div className="ios-feed-copy">
        <span>RESULT · LAUNCH</span>
        <h3>The iOS launch set is ready.</h3>
        <p>4 images, a 1:24 walkthrough, and the signed source package are attached.</p>
        <div><b>NEXT</b><strong>Review the artifacts</strong><i>→</i></div>
      </div>
      <div className="ios-swipe-hint"><i /> SWIPE UP FOR THE NEXT SIGNAL</div>
      <BottomNav />
    </div>
  );
}

function ProfileScreen({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`ios-profile-screen${compact ? " ios-profile-screen--compact" : ""}`}>
      <div className="ios-page-bar"><span>‹</span><strong>Task Profile</strong><i>●</i></div>
      <section className="ios-task-summary">
        <div className="ios-task-agent"><span className="ios-agent-avatar">Z</span><div><strong>Zimlo Agent</strong><small>Codex · zimlo.app</small></div><b>RUNNING</b></div>
        <label>TASK INPUT</label>
        <h3>Redesign the launch site around the real iOS experience.</h3>
        <div className="ios-task-facts">
          <span><small>LATEST CONCLUSION</small><strong>iPhone is now the hero.</strong></span>
          <span><small>NEEDS YOU NOW</small><strong>Review the final experience.</strong></span>
        </div>
      </section>
      <section className="ios-x-timeline">
        <header><strong>Conversation</strong><span>KEY TURNS FIRST</span></header>
        <article className="is-user"><span className="ios-user-avatar">K</span><div><p><b>You</b><small> · 18m</small></p><strong>Make every artifact visible inside the session.</strong><div className="ios-mini-files"><i>IMG</i><i>MOV</i><i>PDF</i></div></div></article>
        <article><span className="ios-agent-avatar">Z</span><div><p><b>Zimlo Agent</b><small> · now</small></p><strong>Artifact viewers now share the originating task context.</strong><p className="ios-timeline-body">Image album, inline video, Markdown, PDF, and source files are ready.</p><button type="button">View 6 execution details</button></div></article>
      </section>
      <div className="ios-reply-composer"><span>＋</span><p>Reply to this session…</p><i>⌁</i><b>↑</b></div>
      <BottomNav />
    </div>
  );
}

function ArtifactVisual({ active }: { active: string }) {
  if (active === "video") {
    return <div className="ios-artifact-video"><div><i>▶</i></div><span>Product walkthrough</span><b>00:38 / 01:24</b></div>;
  }
  if (active === "document") {
    return <div className="ios-artifact-document"><span>MARKDOWN</span><h4>Launch readiness</h4><p>All interaction paths now preserve session context.</p><ul><li>Feed cards verified</li><li>Artifacts attached</li><li>Mobile build passed</li></ul></div>;
  }
  if (active === "pdf") {
    return <div className="ios-artifact-pdf"><div><span>PDF</span><b>01</b><h4>Release brief</h4><p>Mobile attention layer</p></div><footer><strong>release-brief.pdf</strong><span>Full-screen ↗</span></footer></div>;
  }
  return (
    <div className="ios-artifact-album">
      <div className="ios-album-main"><i /><span>01</span></div>
      <div><i /><i /><i /></div>
      <small>1 of 4 · Swipe to browse</small>
    </div>
  );
}

function ArtifactScreen({ active = "images" }: { active?: string }) {
  return (
    <div className="ios-artifact-screen">
      <div className="ios-page-bar"><span>‹</span><strong>Artifacts</strong><i>•••</i></div>
      <div className="ios-artifact-context"><span className="ios-agent-avatar">Z</span><div><strong>Launch assets exported</strong><small>Zimlo Agent · Task Profile</small></div></div>
      <ArtifactVisual active={active} />
      <div className="ios-artifact-caption"><span>ARTIFACT</span><h3>The output stays with its story.</h3><p>Open, read, play, and download without losing the Agent, machine, or task behind it.</p></div>
      <BottomNav />
    </div>
  );
}

function CreateScreen() {
  return (
    <div className="ios-create-screen">
      <div className="ios-page-bar"><span>×</span><strong>New Task</strong><i /></div>
      <section>
        <label>TASK CONTENT <small>DRAFT SAVED</small></label>
        <div className="ios-compose-box"><p>Prepare next week’s launch campaign and export the final assets.</p><footer><span>＋</span><i>⌁</i><b>↑</b></footer></div>
        <label>ATTACHMENTS <small>4 / 10</small></label>
        <div className="ios-create-files"><span><i>IMG</i><b>hero-set.zip</b></span><span><i>PDF</i><b>launch-brief.pdf</b></span><span><i>▶</i><b>demo.mov</b></span><span><i>MD</i><b>copy.md</b></span></div>
        <label>GIVE IT TO</label>
        <div className="ios-agent-choice"><span className="ios-agent-avatar">Z</span><div><strong>Zimlo Agent</strong><small>zimlo · context remembered</small></div><b>Codex⌄</b></div>
      </section>
      <BottomNav />
    </div>
  );
}

function TasksScreen() {
  const rows = [
    ["NEEDS YOU", "Review the iOS launch experience", "zimlo", "REVIEW"],
    ["WORKING", "Prepare the product walkthrough", "marketing", "RUNNING"],
    ["RESUMABLE", "Improve material upload recovery", "ios-app", "READY"],
  ];
  return (
    <div className="ios-tasks-screen">
      <div className="ios-directory-head"><strong>Tasks</strong><span>⌕</span></div>
      <div className="ios-filter-row"><b>All</b><span>Needs me</span><span>Working</span><span>Ready</span></div>
      <section>
        {rows.map((row) => <article key={row[1]}><i>◈</i><div><small>{row[0]}</small><strong>{row[1]}</strong><span>{row[2]} · just now</span></div><b>{row[3]}</b></article>)}
      </section>
      <div className="ios-agent-strip"><header><strong>Project Agents</strong><span>View all →</span></header><div><span className="ios-agent-avatar">Z</span><p><strong>Zimlo Agent</strong><small>Codex + Claude Code · 2 active</small></p><b>New task ＋</b></div></div>
      <BottomNav active="tasks" />
    </div>
  );
}

function ReliabilityScreen() {
  return (
    <div className="ios-reliable-screen">
      <div className="ios-page-bar"><span>‹</span><strong>Reliable control</strong><i>●</i></div>
      <section className="ios-offline-hero"><i>⌁</i><span>OFFLINE-SAFE</span><h3>Your instruction is already safe.</h3><p>Zimlo keeps it on iPhone and sends it exactly once when the right Mac reconnects.</p></section>
      <section className="ios-outbox">
        <header><strong>Pending outbox</strong><span>3 actions</span></header>
        <article><i>↗</i><div><strong>Follow-up instruction</strong><small>Zimlo task · queued offline</small></div><b>RETRY</b></article>
        <article><i>✓</i><div><strong>Approval decision</strong><small>Work Mac · awaiting confirmation</small></div><b>SYNCING</b></article>
        <article><i>⌁</i><div><strong>Material attachment</strong><small>Mac Studio · encrypted</small></div><b>SAFE</b></article>
      </section>
      <div className="ios-security-note"><i>◇</i><p><strong>End-to-end encrypted</strong><small>Zimlo Cloud relays ciphertext only.</small></p></div>
      <BottomNav />
    </div>
  );
}

function ScreenFor({ kind }: { kind: ScreenKind }) {
  switch (kind) {
  case "feed": return <FeedScreen />;
  case "profile": return <ProfileScreen />;
  case "artifacts": return <ArtifactScreen />;
  case "create": return <CreateScreen />;
  case "tasks": return <TasksScreen />;
  case "reliable": return <ReliabilityScreen />;
  }
}

export function HeroPhone() {
  return <PhoneShell label="Zimlo iPhone Feed showing a rich Agent result"><FeedScreen /></PhoneShell>;
}

export function FlagshipExperience() {
  return (
    <div className="ios-flagship-phones">
      <div className="ios-flagship-phone"><span className="ios-phone-label"><b>01</b> MAIN FEED</span><PhoneShell label="TikTok-style one-card Zimlo Feed"><FeedScreen compact /></PhoneShell></div>
      <div className="ios-gesture-path" aria-hidden="true"><span>ENTER SESSION</span><i>→</i><small>one gesture</small></div>
      <div className="ios-flagship-phone ios-flagship-phone--profile"><span className="ios-phone-label"><b>02</b> TASK PROFILE</span><PhoneShell label="X-style Zimlo Task Profile"><ProfileScreen compact /></PhoneShell></div>
    </div>
  );
}

export function ArtifactShowcase() {
  const [active, setActive] = useState<(typeof artifactTypes)[number]["id"]>("images");
  return (
    <div className="ios-artifact-showcase">
      <div className="ios-artifact-picker" role="tablist" aria-label="Artifact preview types">
        {artifactTypes.map((item, index) => (
          <button key={item.id} className={active === item.id ? "active" : ""} type="button" role="tab" aria-selected={active === item.id} onClick={() => setActive(item.id)}>
            <span>0{index + 1}</span><strong>{item.label}</strong><small>{item.meta}</small><i>↗</i>
          </button>
        ))}
      </div>
      <PhoneShell label={`${artifactTypes.find((item) => item.id === active)?.label} inside the Zimlo iPhone app`} className="ios-artifact-phone">
        <ArtifactScreen active={active} />
      </PhoneShell>
    </div>
  );
}

export function FeatureTour() {
  const [active, setActive] = useState<ScreenKind>("feed");
  const selected = tourItems.find((item) => item.id === active) ?? tourItems[0];
  return (
    <div className="ios-feature-tour">
      <div className="ios-tour-tabs" role="tablist" aria-label="Explore Zimlo capabilities">
        {tourItems.map((item, index) => (
          <button key={item.id} type="button" role="tab" aria-selected={active === item.id} className={active === item.id ? "active" : ""} onClick={() => setActive(item.id)}>
            <span>0{index + 1}</span>{item.label}
          </button>
        ))}
      </div>
      <div className="ios-tour-stage">
        <div className="ios-tour-copy" key={`${active}-copy`}>
          <span>{selected.label.toUpperCase()}</span>
          <h3>{selected.title}</h3>
          <p>{selected.body}</p>
          <ul>{selected.facts.map((fact) => <li key={fact}><i>✓</i>{fact}</li>)}</ul>
        </div>
        <div className="ios-tour-phone" key={active}>
          <PhoneShell label={`${selected.label} screen in Zimlo for iPhone`}><ScreenFor kind={active} /></PhoneShell>
        </div>
      </div>
    </div>
  );
}
