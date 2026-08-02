import { BetaDownload } from "./BetaDownload";
import { MotionController } from "./MotionController";
import { WaitlistForm } from "./WaitlistForm";
import { isWaitlistLive } from "./waitlist-live";

const liveSignals = [
  {
    status: "RESULT",
    agent: "CODEX · MACBOOK PRO",
    time: "NOW",
    title: "Release candidate ready to review",
    body: "43 tests passed. No unresolved review threads.",
    accent: "result",
    footer: "Open proof or continue the task",
  },
  {
    status: "MEDIA",
    agent: "CLAUDE CODE · MAC STUDIO",
    time: "1 MIN",
    title: "Launch assets exported",
    body: "4 images · 1 walkthrough · 2 source files",
    accent: "media",
    footer: "Preview every output in the Feed",
  },
  {
    status: "APPROVAL",
    agent: "CODEX · WORK MAC",
    time: "2 MIN",
    title: "Approve this production push once?",
    body: "Target and risk are attached to the original task.",
    accent: "approval",
    footer: "Approve or decline in one tap",
  },
];

const storySteps = [
  {
    number: "01",
    kicker: "EDITORIAL FEED",
    title: "The feed edits itself.",
    body: "Agents publish the conclusion, proof, and next move. Routine logs and tool chatter never compete for your attention.",
    chips: ["Results", "Approvals", "Failures"],
  },
  {
    number: "02",
    kicker: "RICH OUTPUTS",
    title: "Review what the agent actually made.",
    body: "Images open as albums, videos keep their poster and playback context, and files stay attached to the task that produced them.",
    chips: ["Images", "Video", "Files"],
  },
  {
    number: "03",
    kicker: "MULTI-MAC ROUTING",
    title: "Every source stays correctly scoped.",
    body: "Pair every Mac you use. Zimlo merges Codex and Claude Code work into one Feed while preserving the machine, project, and task behind each action.",
    chips: ["MacBook Pro", "Mac Studio", "Work Mac"],
  },
];

const demoCards = [
  {
    type: "RESULT",
    agent: "CODEX",
    title: "The release candidate is ready",
    body: "Tests, review status, and the meaningful diff are edited into one card.",
    next: "Review the proof",
  },
  {
    type: "MEDIA",
    agent: "CLAUDE CODE",
    title: "The product walkthrough is exported",
    body: "Watch the video, browse the image set, or download the source package in context.",
    next: "Open 7 outputs",
  },
  {
    type: "APPROVAL",
    agent: "CODEX",
    title: "A production push needs you",
    body: "Purpose, target, source machine, and risk stay visible before you decide.",
    next: "Review and decide",
  },
];

const setupSteps = [
  ["Download", "Open the macOS menu bar app."],
  ["Connect", "Pair every Mac and Agent source."],
  ["Scan", "Bring the unified Feed to iPhone."],
];

function BrandMark({ small = false }: { small?: boolean }) {
  return (
    <span className={small ? "brand-mark brand-mark--small" : "brand-mark"} aria-hidden="true">
      <span>✦</span>
    </span>
  );
}

function ArrowIcon() {
  return <span aria-hidden="true">↗</span>;
}

function ProductDemo({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? "v2-product-demo v2-product-demo--compact" : "v2-product-demo"}>
      <div className="v2-window-bar" aria-hidden="true">
        <span><i /><i /><i /></span>
        <strong>ZIMLO · LIVE FEED</strong>
        <small>END-TO-END ENCRYPTED</small>
      </div>
      <div className="v2-workbench">
        <aside className="v2-source-rail" aria-label="Connected Agent sources">
          <span className="v2-source-label">SOURCES</span>
          <div className="v2-source v2-source--active">
            <i />
            <strong>MacBook Pro</strong>
            <small>Codex · zimlo</small>
          </div>
          <div className="v2-source">
            <i />
            <strong>Mac Studio</strong>
            <small>Claude Code · api</small>
          </div>
          <div className="v2-source">
            <i />
            <strong>Work Mac</strong>
            <small>Codex · client</small>
          </div>
        </aside>

        <div className="v2-feed-canvas">
          <div className="v2-feed-header">
            <div>
              <span>ONE FEED</span>
              <strong>What needs you now</strong>
            </div>
            <span className="v2-live-status"><i /> 3 SOURCES LIVE</span>
          </div>
          <div className="v2-card-viewport" aria-label="A rotating preview of Zimlo Feed cards">
            {liveSignals.map((signal, index) => (
              <article className={`v2-live-card v2-live-card--${signal.accent}`} style={{ "--card-order": index } as React.CSSProperties} key={signal.title}>
                <div className="v2-live-card-topline">
                  <span>{signal.status}</span>
                  <small>{signal.time}</small>
                </div>
                <span className="v2-live-card-agent">{signal.agent}</span>
                <h3>{signal.title}</h3>
                <p>{signal.body}</p>
                {signal.accent === "media" && (
                  <div className="v2-media-row" aria-hidden="true">
                    <i>IMG</i><i>▶</i><i>PDF</i><i>ZIP</i>
                  </div>
                )}
                <div className="v2-card-next"><span>NEXT</span><strong>{signal.footer}</strong><b>→</b></div>
              </article>
            ))}
          </div>
        </div>
      </div>
      <div className="v2-demo-glow" aria-hidden="true" />
    </div>
  );
}

export default async function Home() {
  const waitlistLive = await isWaitlistLive();

  return (
    <main className="v2-page">
      <MotionController />

      <header className="v2-header">
        <a className="brand" href="#top" aria-label="Zimlo home">
          <BrandMark small />
          <span>ZIMLO</span>
        </a>
        <nav aria-label="Primary navigation">
          <a href="#product">Product</a>
          <a href="#demo">Demo</a>
          <a href="#privacy">Privacy</a>
          <a href="#setup">Get started</a>
        </nav>
        <a className="v2-header-cta" href="#beta">Mac Beta <ArrowIcon /></a>
      </header>

      <section className="v2-hero" id="top">
        <div className="v2-hero-copy">
          <div className="v2-eyebrow"><i /> THE MOBILE ATTENTION LAYER FOR AI WORK</div>
          <h1><span>Leave your Mac.</span><em>Stay in the loop.</em></h1>
          <p>One encrypted Feed for Codex and Claude Code across every Mac—results, approvals, images, video, and files.</p>
          {waitlistLive ? (
            <WaitlistForm source="hero" tone="dark" />
          ) : (
            <div className="v2-hero-actions">
              <a className="v2-button v2-button--primary" href="#beta">Join the Mac Beta <ArrowIcon /></a>
              <a className="v2-button v2-button--ghost" href="#product">Watch the Feed work <span aria-hidden="true">↓</span></a>
            </div>
          )}
          <div className="v2-metrics" aria-label="Core experience targets">
            <div><strong>3s</strong><span>Know</span></div>
            <div><strong>10s</strong><span>Act</span></div>
            <div><strong>20s</strong><span>Brief</span></div>
          </div>
        </div>

        <div className="v2-hero-product" aria-label="Animated Zimlo product preview">
          <ProductDemo />
          <span className="v2-float-chip v2-float-chip--media"><i>▶</i> VIDEO READY</span>
          <span className="v2-float-chip v2-float-chip--source"><i /> MAC STUDIO JOINED</span>
        </div>

        <div className="v2-scroll-cue" aria-hidden="true"><span>SCROLL TO FOLLOW THE SIGNAL</span><i /></div>
      </section>

      <div className="v2-ticker" aria-hidden="true">
        <div>
          <span>RESULTS, NOT LOGS</span><i>✦</i><span>IMAGES · VIDEO · FILES</span><i>✦</i><span>EVERY MAC · ONE FEED</span><i>✦</i>
          <span>RESULTS, NOT LOGS</span><i>✦</i><span>IMAGES · VIDEO · FILES</span><i>✦</i><span>EVERY MAC · ONE FEED</span><i>✦</i>
        </div>
      </div>

      <section className="v2-story" id="product">
        <div className="v2-section-heading" data-reveal>
          <span>ONE FEED · THREE PROMISES</span>
          <h2>Follow the work.<br />Never babysit it.</h2>
          <p>Zimlo keeps the result, its source, and the next action together—without turning your phone into another terminal.</p>
        </div>

        <div className="v2-story-layout">
          <div className="v2-story-visual" data-reveal>
            <ProductDemo compact />
            <div className="v2-story-caption"><i /> LIVE PRODUCT SYSTEM · NO REMOTE SHELL</div>
          </div>
          <div className="v2-story-steps" id="capabilities">
            {storySteps.map((step) => (
              <article className="v2-story-step" data-reveal key={step.number}>
                <span className="v2-story-number">{step.number}</span>
                <span className="v2-story-kicker">{step.kicker}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
                <div>{step.chips.map((chip) => <span key={chip}>{chip}</span>)}</div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="v2-demo-section" id="demo">
        <div className="v2-section-heading v2-section-heading--dark" data-reveal>
          <span>REAL MOMENTS · CLEAR NEXT MOVES</span>
          <h2>Open only what<br />deserves attention.</h2>
          <p>Each card starts with the changed reality, shows the proof, and ends with one obvious next action.</p>
        </div>
        <div className="v2-demo-grid">
          {demoCards.map((card, index) => (
            <article className="v2-demo-card" data-reveal style={{ "--reveal-delay": `${index * 90}ms` } as React.CSSProperties} key={card.title}>
              <div className="v2-demo-topline"><span>{card.type}</span><small>{card.agent}</small><i /></div>
              <h3>{card.title}</h3>
              <p>{card.body}</p>
              <div className="v2-demo-action"><span>NEXT</span><strong>{card.next}</strong><b>↗</b></div>
            </article>
          ))}
        </div>
      </section>

      <section className="v2-privacy" id="privacy">
        <div className="v2-privacy-copy" data-reveal>
          <span>LOCAL SOURCES OF TRUTH</span>
          <h2>The cloud connects.<br /><em>It cannot read.</em></h2>
          <p>Each Mac owns its Agent data. Zimlo Cloud relays only end-to-end encrypted content, while your phone keeps a source-scoped cache and reliable reconnect queue.</p>
          <div><span>NO CODE STORAGE</span><span>NO PROMPT STORAGE</span><span>NO REMOTE SHELL</span></div>
        </div>
        <div className="v2-route-map" data-reveal aria-label="Encrypted connections from multiple Macs to one iPhone">
          <div className="v2-route-sources">
            <span><i /> MACBOOK PRO <small>CODEX</small></span>
            <span><i /> MAC STUDIO <small>CLAUDE CODE</small></span>
            <span><i /> WORK MAC <small>CODEX</small></span>
          </div>
          <div className="v2-route-line" aria-hidden="true"><i /><i /><i /></div>
          <div className="v2-route-phone"><BrandMark small /><span>YOUR IPHONE</span><strong>Approve · Reply<br />Review · Brief</strong></div>
          <small className="v2-relay-label">ENCRYPTED RELAY · ZERO CONTENT ACCESS</small>
        </div>
      </section>

      <section className="v2-setup" id="setup">
        <div className="v2-section-heading" data-reveal>
          <span>ZERO-COMMAND ONBOARDING</span>
          <h2>Three steps.<br />Then real work.</h2>
        </div>
        <div className="v2-setup-grid">
          {setupSteps.map(([title, body], index) => (
            <article data-reveal style={{ "--reveal-delay": `${index * 90}ms` } as React.CSSProperties} key={title}>
              <span>0{index + 1}</span><h3>{title}</h3><p>{body}</p><i aria-hidden="true">→</i>
            </article>
          ))}
        </div>
      </section>

      <section className="v2-cta" id="beta">
        <div className="v2-cta-orbit" aria-hidden="true"><i /><i /><i /></div>
        <BrandMark />
        <span>MACOS BETA</span>
        <h2>Leave your Mac.<br />Stay in the loop.</h2>
        <p>The first group of Codex and Claude Code users can join now.</p>
        {waitlistLive ? <WaitlistForm source="beta" tone="acid" /> : <BetaDownload />}
      </section>

      <footer className="v2-footer">
        <a className="brand" href="#top"><BrandMark small /><span>ZIMLO</span></a>
        <p>The mobile attention layer for AI work.</p>
        <nav aria-label="Footer navigation"><a href="https://github.com/rsgok/zimlo" rel="noopener noreferrer">GitHub</a><a href="/privacy">Privacy</a></nav>
        <span>© 2026 Zimlo</span>
      </footer>
    </main>
  );
}
