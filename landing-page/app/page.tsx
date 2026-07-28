/* eslint-disable @next/next/no-img-element */

import { BetaDownload } from "./BetaDownload";

const features = [
  {
    index: "01",
    label: "EDITORIAL FEED",
    title: "See the signal. Lose the transcript.",
    body: "Zimlo edits agent activity into the few conclusions, decisions, and results that can change what you do next.",
  },
  {
    index: "02",
    label: "SWIPE TO COLLABORATE",
    title: "Browse like TikTok. Respond like X.",
    body: "One focused card at a time. Swipe through important work, open the thread, approve, reply, or request a revision in seconds.",
  },
  {
    index: "03",
    label: "QUIET BY DESIGN",
    title: "Your phone speaks only when you are needed.",
    body: "Approvals, failures, and results to review make the cut. Progress logs, heartbeats, and routine tool calls stay silent.",
  },
];

const setupSteps = [
  ["Download Zimlo", "Open it once. From then on, it stays quietly in your menu bar."],
  ["Connect your agents", "Zimlo finds Codex and Claude Code, and changes nothing until you approve."],
  ["Scan one QR code", "Your iPhone and Mac do not need to be on the same Wi-Fi network."],
  ["Start with real value", "Your first meaningful card—not another settings screen—completes onboarding."],
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

export default function Home() {
  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Zimlo home">
          <BrandMark small />
          <span>ZIMLO</span>
        </a>
        <nav aria-label="Primary navigation">
          <a href="#product">Product</a>
          <a href="#privacy">Privacy</a>
          <a href="#setup">Get started</a>
        </nav>
        <a className="header-cta" href="#beta">
          Mac Beta <ArrowIcon />
        </a>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <div className="eyebrow">
            <span className="live-dot" />
            THE EDITED FEED FOR YOUR AI WORK
          </div>
          <h1>
            Your AI work,
            <br />
            <span>edited down to what matters.</span>
          </h1>
          <p className="hero-lede">
            Zimlo turns Codex and Claude Code activity into a calm, swipeable feed.
            See one meaningful update at a time—then approve, reply, or keep scrolling.
          </p>
          <div className="hero-actions">
            <a className="button button--primary" href="#beta">
              Join the Mac Beta <ArrowIcon />
            </a>
            <a className="button button--ghost" href="#product">
              See how it works
            </a>
          </div>
          <div className="hero-trust">
            <span>No logs to babysit</span>
            <span>One card at a time</span>
            <span>End-to-end encrypted</span>
          </div>
        </div>

        <div className="product-stage" aria-label="Zimlo product interface preview">
          <div className="orbit orbit--one" />
          <div className="orbit orbit--two" />
          <figure className="real-desktop-frame">
            <div className="real-desktop-chrome" aria-hidden="true">
              <div className="window-dots"><i /><i /><i /></div>
              <span>127.0.0.1 · Zimlo</span>
              <span>PRODUCT MOCK</span>
            </div>
            <img src="/zimlo-feed-desktop-en.png" width={1280} height={720} alt="Zimlo's English one-card Feed on macOS" />
          </figure>

          <figure className="real-phone-frame">
            <div className="real-phone-screen">
              <img src="/zimlo-feed-mobile-en.png" width={393} height={852} alt="Zimlo's English mobile Feed at 393 by 852 pixels" />
            </div>
            <figcaption>393 × 852 · PRODUCT-ACCURATE MOCK</figcaption>
          </figure>
        </div>
      </section>

      <section className="speed-strip" aria-label="Core experience targets">
        <div><strong>3s</strong><span>Know what needs attention</span></div>
        <div><strong>10s</strong><span>Approve, reply, or review</span></div>
        <div><strong>20s</strong><span>Brief a new task</span></div>
        <div className="speed-note"><span>Signal, not activity.</span></div>
      </section>

      <section className="section product-section" id="product">
        <div className="section-intro">
          <span className="section-kicker">ONE CARD. ONE DECISION.</span>
          <h2>Agent activity is infinite.<br />Your attention is not.</h2>
          <p>Zimlo is not another terminal, inbox, or dashboard. It is an editorial layer that keeps only what changes your judgment, action, or confidence.</p>
        </div>

        <div className="attention-demo">
          <figure className="attention-product-capture">
            <div className="attention-product-device">
              <img src="/zimlo-feed-mobile-en.png" width={393} height={852} alt="An English mock of Zimlo's actual one-card mobile Feed" />
            </div>
            <figcaption>
              <span>PRODUCT-ACCURATE ENGLISH MOCK</span>
              <strong>One viewport. One card. One next move.</strong>
            </figcaption>
          </figure>
          <div className="attention-principle">
            <span className="principle-number">01</span>
            <h3>Scroll through work the way you already browse everything else.</h3>
            <p>Each card has a conclusion and a clear next move. Open its thread for context, respond in place, or swipe on. Finished work quietly becomes history.</p>
            <div className="principle-line" />
            <span className="principle-caption">TIKTOK CLARITY · X-SPEED COLLABORATION</span>
          </div>
        </div>
      </section>

      <section className="features-section">
        <div className="feature-grid">
          {features.map((feature) => (
            <article className="feature-card" key={feature.index}>
              <div className="feature-index">{feature.index}</div>
              <span className="feature-label">{feature.label}</span>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
              <span className="feature-arrow">↗</span>
            </article>
          ))}
        </div>
      </section>

      <section className="privacy-section" id="privacy">
        <div className="privacy-copy">
          <span className="section-kicker section-kicker--light">LOCAL SOURCE OF TRUTH</span>
          <h2>The cloud connects.<br /><em>Your Mac remembers.</em></h2>
          <p>
            Task text, code, and results never enter Zimlo Cloud. When your Mac is online, Cloudflare relays an
            already encrypted connection. When it is offline, your phone shows its local cache and queues actions for reconnect.
          </p>
          <div className="privacy-badges">
            <span>NO CODE STORAGE</span>
            <span>NO PROMPT STORAGE</span>
            <span>NO REMOTE SHELL</span>
          </div>
        </div>

        <div className="connection-diagram" aria-label="Connection between your Mac, encrypted relay, and iPhone">
          <div className="diagram-node diagram-node--mac">
            <span className="node-icon">⌘</span>
            <strong>YOUR MAC</strong>
            <small>Source of truth</small>
          </div>
          <div className="diagram-link">
            <span className="packet packet--one">◆</span>
            <span className="packet packet--two">◆</span>
            <div className="link-line" />
            <strong>END-TO-END ENCRYPTED</strong>
          </div>
          <div className="diagram-node diagram-node--phone">
            <span className="node-icon">▯</span>
            <strong>YOUR IPHONE</strong>
            <small>Approve · Reply · Review</small>
          </div>
          <div className="relay-label">CLOUDFLARE RELAY · CANNOT READ TASK CONTENT</div>
        </div>
      </section>

      <section className="section setup-section" id="setup">
        <div className="section-intro setup-intro">
          <span className="section-kicker">ZERO COMMAND ONBOARDING</span>
          <h2>Download. Open. Scan.<br />No bridge to understand.</h2>
          <p>You should never have to run `zimlo start`. Zimlo lives in the menu bar and explains each permission only when it matters.</p>
        </div>
        <div className="setup-grid">
          {setupSteps.map(([title, body], index) => (
            <article className="setup-step" key={title}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div>
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="beta-section" id="beta">
        <div className="beta-orb"><BrandMark /></div>
        <span className="section-kicker">MACOS BETA</span>
        <h2>Follow the work.<br />Skip the noise.</h2>
        <p>The macOS menu bar app and iPhone companion are opening to the first group of users.</p>
        <BetaDownload />
      </section>

      <footer className="site-footer">
        <a className="brand brand--footer" href="#top">
          <BrandMark small />
          <span>ZIMLO</span>
        </a>
        <p>The edited feed for your AI work.</p>
        <span>© 2026 Zimlo</span>
      </footer>
    </main>
  );
}
