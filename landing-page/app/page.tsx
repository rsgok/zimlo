/* eslint-disable @next/next/no-img-element */

import { BetaDownload } from "./BetaDownload";
import { WaitlistForm } from "./WaitlistForm";
import { isWaitlistLive } from "./waitlist-live";

const features = [
  {
    index: "01",
    label: "EDITORIAL FEED",
    title: "See the signal. Lose the transcript.",
    body: "Agents write the few conclusions, decisions, and results that can change what you do next. Zimlo leaves routine activity out.",
  },
  {
    index: "02",
    label: "RICH OUTPUTS",
    title: "Review the work, not just a text summary.",
    body: "Images, video, and files arrive as first-class results in the Feed, ready to preview from the task that produced them.",
  },
  {
    index: "03",
    label: "MULTI-MAC SOURCES",
    title: "Every machine. Every agent. One view.",
    body: "Bring Codex and Claude Code work from multiple Macs into one Feed while keeping its source machine, project, and task clear.",
  },
  {
    index: "04",
    label: "RELIABLE BY DESIGN",
    title: "Weak networks do not get the final word.",
    body: "Draft recovery, a persistent outbox, idempotent sends, and reconnect queues keep mobile commands from disappearing or running twice.",
  },
];

const demoCards = [
  {
    tone: "result",
    status: "RESULT",
    agent: "CODEX",
    time: "2 MIN AGO",
    index: "01",
    title: "The release candidate is ready to review",
    lines: [
      "43 tests passed · 0 unresolved review threads",
      "Retry logic extracted into a shared helper · +212 −148",
    ],
    next: "Open the task to review the proof or continue the conversation.",
  },
  {
    tone: "approval",
    status: "APPROVAL",
    agent: "CLAUDE CODE",
    time: "JUST NOW",
    index: "02",
    title: "Approve this push once?",
    lines: [
      "git push origin feat/retry-logic — first push of this branch",
      "Target: current project · Risk: creates an external change",
    ],
    next: "Review the scope and risk, then approve or decline explicitly.",
  },
  {
    tone: "failure",
    status: "FAILURE",
    agent: "CODEX",
    time: "8 MIN AGO",
    index: "03",
    title: "Tests failed in the auth flow",
    lines: [
      "2 of 41 tests failing · src/auth/session.test.ts",
      "A fix is already drafted and waiting for your review",
    ],
    next: "Open the task to inspect the failure and decide whether to retry.",
  },
];

const setupSteps = [
  ["Download Zimlo", "Open it once. From then on, it stays quietly in your menu bar."],
  ["Connect your Macs and agents", "Add Codex and Claude Code sources from every Mac you use. Each one stays independently scoped."],
  ["Scan to pair", "Pair each Mac with your iPhone. They do not need to share the same Wi-Fi network."],
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

export default async function Home() {
  const waitlistLive = await isWaitlistLive();

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Zimlo home">
          <BrandMark small />
          <span>ZIMLO</span>
        </a>
        <nav aria-label="Primary navigation">
          <a href="#product">Product</a>
          <a href="#capabilities">Capabilities</a>
          <a href="#demo">Demo</a>
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
            THE MOBILE ATTENTION LAYER FOR AI WORK
          </div>
          <h1>
            Leave your Mac.
            <br />
            <span>Stay in the loop.</span>
          </h1>
          <p className="hero-lede">
            Zimlo brings Codex and Claude Code work from every Mac into one calm, swipeable Feed.
            Review conclusions, images, video, and files—then act in seconds and get back to your day.
          </p>
          {waitlistLive ? (
            <WaitlistForm source="hero" tone="dark" />
          ) : (
            <div className="hero-actions">
              <a className="button button--primary" href="#beta">
                Join the Mac Beta <ArrowIcon />
              </a>
              <a className="button button--ghost" href="#demo">
                See how it works
              </a>
            </div>
          )}
          <div className="hero-trust">
            <span>Images, video, and files</span>
            <span>Every Mac, one Feed</span>
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
              <span>ENCRYPTED · LOCAL FIRST</span>
            </div>
            <img src="/zimlo-feed-desktop-en.png" width={1280} height={720} alt="Zimlo's English one-card Feed on macOS" />
          </figure>

          <figure className="real-phone-frame">
            <div className="real-phone-screen">
              <img src="/zimlo-feed-mobile-en.png" width={393} height={852} alt="Zimlo's English mobile Feed at 393 by 852 pixels" />
            </div>
            <figcaption>393 × 852 · ONE CARD AT A TIME</figcaption>
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
              <img src="/zimlo-feed-mobile-en.png" width={393} height={852} alt="An English preview of Zimlo's actual one-card mobile Feed" />
            </div>
            <figcaption>
              <span>ENGLISH FEED PREVIEW</span>
              <strong>One viewport. One card. One next move.</strong>
            </figcaption>
          </figure>
          <div className="attention-principle">
            <span className="principle-number">01</span>
            <h3>Scroll through work. Open only what deserves your attention.</h3>
            <p>Each card starts with a conclusion and a clear next move. Open its task for the original input, current state, proof, and conversation—or swipe on. Finished work quietly becomes history.</p>
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

      <section className="capabilities-section" id="capabilities">
        <div className="capabilities-intro">
          <span className="section-kicker">RICH OUTPUTS · MANY SOURCES</span>
          <h2>AI work is more than text.<br />And it does not live on one machine.</h2>
          <p>
            Zimlo keeps the result and its origin together. Preview what an agent made, see which Mac and project it came from,
            and continue on the right task without reconstructing the context.
          </p>
        </div>

        <div className="capability-grid">
          <article className="capability-panel capability-panel--media">
            <div className="capability-panel-heading">
              <span>01 / MULTIMODAL RESULTS</span>
              <h3>See the output in the Feed.</h3>
              <p>Images open as albums, videos keep their poster and playback context, and files arrive with a useful preview or summary.</p>
            </div>
            <div className="media-preview" aria-label="Examples of image, video, and file results in Zimlo">
              <div className="media-preview-card media-preview-card--image">
                <div className="media-preview-topline"><span>IMAGE</span><span>4 ASSETS</span></div>
                <div className="image-preview-art" aria-hidden="true"><i /><i /><i /></div>
                <strong>Launch visuals are ready</strong>
                <small>Open the task to review all four images.</small>
              </div>
              <div className="media-preview-card media-preview-card--video">
                <div className="media-preview-topline"><span>VIDEO</span><span>01:24</span></div>
                <div className="video-preview-art" aria-hidden="true"><span>▶</span></div>
                <strong>Product walkthrough exported</strong>
                <small>Poster, playback, and source task stay together.</small>
              </div>
              <div className="file-preview-list">
                <div><span className="file-type">PDF</span><strong>Research brief.pdf</strong><small>2.4 MB</small></div>
                <div><span className="file-type">ZIP</span><strong>Release assets.zip</strong><small>18.7 MB</small></div>
              </div>
            </div>
          </article>

          <article className="capability-panel capability-panel--sources">
            <div className="capability-panel-heading">
              <span>02 / MULTI-MACHINE SOURCES</span>
              <h3>One phone for every Agent workspace.</h3>
              <p>Pair multiple Macs and Zimlo merges their work into one attention layer without losing source identity or routing.</p>
            </div>
            <div className="source-map" aria-label="Multiple Macs and coding agents connected to one Zimlo Feed">
              <div className="source-machine source-machine--one">
                <span className="source-status">ONLINE</span>
                <strong>MACBOOK PRO</strong>
                <small>Codex · zimlo</small>
              </div>
              <div className="source-machine source-machine--two">
                <span className="source-status">ONLINE</span>
                <strong>MAC STUDIO</strong>
                <small>Claude Code · api</small>
              </div>
              <div className="source-machine source-machine--three">
                <span className="source-status source-status--cached">CACHED</span>
                <strong>WORK MAC</strong>
                <small>Codex · client-app</small>
              </div>
              <div className="source-lines" aria-hidden="true"><i /><i /><i /></div>
              <div className="source-destination">
                <BrandMark small />
                <span>ONE MOBILE FEED</span>
                <strong>Correct source.<br />Correct task.<br />Correct next move.</strong>
              </div>
            </div>
          </article>
        </div>
      </section>

      <section className="demo-section" id="demo">
        <div className="section-intro">
          <span className="section-kicker">WHAT THE FEED ACTUALLY SAYS</span>
          <h2>Real cards.<br />Real next moves.</h2>
          <p>Not screenshots of a terminal—three kinds of moments Zimlo brings into your Feed: a result to review, an approval to sign off, and a failure that changes the plan.</p>
        </div>

        <div className="demo-card-grid">
          {demoCards.map((card) => (
            <article className={`demo-card demo-card--${card.tone}`} key={card.index}>
              <div className="demo-card-topline">
                <span className="demo-card-status">{card.status}</span>
                <span className="demo-card-agent">{card.agent}</span>
                <span className="demo-card-time">{card.time}</span>
              </div>
              <h3>{card.title}</h3>
              <ul>
                {card.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <div className="demo-card-next">
                <span>NEXT</span>
                <strong>{card.next}</strong>
                <span className="demo-card-index" aria-hidden="true">{card.index} / 03</span>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="privacy-section" id="privacy">
        <div className="privacy-copy">
          <span className="section-kicker section-kicker--light">LOCAL SOURCE OF TRUTH</span>
          <h2>The cloud connects.<br /><em>Your Macs stay in control.</em></h2>
          <p>
            Task content reaches Zimlo Cloud only as end-to-end encrypted data it cannot read. Each Mac stays a local source of truth;
            when one is temporarily offline, your phone keeps its scoped cache and queues actions for that source to reconnect.
          </p>
          <div className="privacy-badges">
            <span>NO CODE STORAGE</span>
            <span>NO PROMPT STORAGE</span>
            <span>NO REMOTE SHELL</span>
          </div>
        </div>

        <div className="connection-diagram" aria-label="Connection between your Macs, encrypted relay, and iPhone">
          <div className="diagram-node diagram-node--mac">
            <span className="node-icon">⌘×N</span>
            <strong>YOUR MACS</strong>
            <small>Independent sources of truth</small>
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
          <p>No terminal setup for ordinary use. Zimlo lives in the menu bar and explains each permission only when it matters.</p>
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
        <h2>Leave your Mac.<br />Stay in the loop.</h2>
        <p>The macOS menu bar app and iPhone companion are opening to the first group of Codex and Claude Code users.</p>
        {waitlistLive ? (
          <WaitlistForm source="beta" tone="acid" />
        ) : (
          <BetaDownload />
        )}
      </section>

      <footer className="site-footer">
        <a className="brand brand--footer" href="#top">
          <BrandMark small />
          <span>ZIMLO</span>
        </a>
        <p>The mobile attention layer for your AI work.</p>
        <nav aria-label="Footer navigation">
          <a href="https://github.com/rsgok/zimlo" rel="noopener noreferrer">GitHub</a>
          <a href="/privacy">Privacy policy</a>
        </nav>
        <span>© 2026 Zimlo</span>
      </footer>
    </main>
  );
}
