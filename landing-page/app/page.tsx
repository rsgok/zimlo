import { BetaDownload } from "./BetaDownload";
import { ArtifactShowcase, FeatureTour, FlagshipExperience, HeroPhone } from "./IOSShowcase";
import { MotionController } from "./MotionController";
import { WaitlistForm } from "./WaitlistForm";
import { isWaitlistLive } from "./waitlist-live";

const capabilities = [
  ["01", "TikTok-style Feed", "Full-screen, one-card paging for only the results, decisions, failures, and approvals that deserve you."],
  ["02", "X-style Task Profile", "Task input, current state, latest conclusion, next action, and the human–Agent conversation in one session profile."],
  ["03", "Rich Artifact viewers", "Image albums, inline video, readable Markdown and text, embedded PDFs, source files, and Quick Look."],
  ["04", "Approvals + input", "Review purpose, target, source, and risk; approve, decline, or answer the Agent without leaving the task."],
  ["05", "Create + continue", "Start new work or reply in context with text, voice, photos, video, PDFs, and working files."],
  ["06", "Task management", "Search, filter, pin, archive, retry, resume, and group sessions by what needs you next."],
  ["07", "Project Agents", "Keep project identity, avatar, workspace, default runtime, and active tasks together."],
  ["08", "Multi-Mac sources", "Bring Codex and Claude Code from every Mac into one iPhone while preserving the correct source."],
  ["09", "Offline outbox", "Draft recovery, persistent queues, reconnect retries, and idempotency protect every mobile action."],
  ["10", "Secure pairing", "Scan a QR code, keep device keys locally, and route only end-to-end encrypted content through the cloud."],
  ["11", "Smart notifications", "Open the exact task from a notification and keep a recoverable route when a session is still syncing."],
  ["12", "Caught-up by design", "Know when nothing needs you. New actionable work resurfaces without turning the Feed into an activity log."],
];

const setupSteps = [
  ["01", "Install the companion", "Zimlo stays quietly beside Codex and Claude Code on each Mac."],
  ["02", "Pair your iPhone", "Scan once. Device keys stay on your devices."],
  ["03", "Leave the desk", "Review, approve, reply, and brief new work from the mobile Feed."],
];

function BrandMark({ small = false }: { small?: boolean }) {
  return <span className={small ? "brand-mark brand-mark--small" : "brand-mark"} aria-hidden="true"><span>✦</span></span>;
}

export default async function Home() {
  const waitlistLive = await isWaitlistLive();

  return (
    <main className="ios-site">
      <MotionController />

      <header className="ios-site-header">
        <a className="brand" href="#top" aria-label="Zimlo home"><BrandMark small /><span>ZIMLO</span></a>
        <nav aria-label="Primary navigation">
          <a href="#flagship">Experience</a>
          <a href="#artifacts">Artifacts</a>
          <a href="#capabilities">Everything</a>
          <a href="#privacy">Privacy</a>
        </nav>
        <a className="ios-header-cta" href="#beta">Join Beta <span aria-hidden="true">↗</span></a>
      </header>

      <section className="ios-hero" id="top">
        <div className="ios-hero-copy">
          <div className="ios-kicker"><i /> ZIMLO FOR IPHONE</div>
          <h1>Your Agents<br />keep working.<br /><em>Your iPhone</em><br />keeps you in control.</h1>
          <p>A mobile attention layer for Codex and Claude Code—built around a TikTok-style main Feed and an X-style profile for every session.</p>
          {waitlistLive ? (
            <WaitlistForm source="hero" tone="dark" />
          ) : (
            <div className="ios-hero-actions">
              <a className="ios-button ios-button--acid" href="#beta">Join the iPhone Beta <span aria-hidden="true">↗</span></a>
              <a className="ios-button ios-button--line" href="#flagship">See the experience <span aria-hidden="true">↓</span></a>
            </div>
          )}
          <div className="ios-speed-promise" aria-label="Core mobile experience targets">
            <span><strong>3s</strong><small>know what matters</small></span>
            <span><strong>10s</strong><small>review or act</small></span>
            <span><strong>20s</strong><small>brief new work</small></span>
          </div>
        </div>

        <div className="ios-hero-stage" aria-label="Zimlo running on iPhone">
          <div className="ios-hero-halo" aria-hidden="true"><i /><i /><i /></div>
          <div className="ios-hero-source ios-hero-source--one" aria-hidden="true"><i /> CODEX <small>MacBook Pro</small></div>
          <div className="ios-hero-source ios-hero-source--two" aria-hidden="true"><i /> CLAUDE CODE <small>Mac Studio</small></div>
          <HeroPhone />
          <span className="ios-hero-note ios-hero-note--one">FULL-SCREEN FEED <i>↗</i></span>
          <span className="ios-hero-note ios-hero-note--two">ARTIFACTS INSIDE <i>04</i></span>
        </div>
        <div className="ios-hero-principle"><span>IPHONE RUNS THE EXPERIENCE</span><i>✦</i><span>MACS RUN THE WORK</span></div>
      </section>

      <section className="ios-flagship" id="flagship">
        <div className="ios-section-copy" data-reveal>
          <span>THE TWO EXPERIENCES WE ARE PROUD OF</span>
          <h2>From a signal<br />to its whole story.</h2>
          <p>The main Feed stays brutally focused. One gesture opens the session behind it—with all the context, artifacts, and conversation intact.</p>
        </div>
        <div data-reveal><FlagshipExperience /></div>
        <div className="ios-flagship-notes">
          <article data-reveal><span>01 · MAIN FEED</span><h3>TikTok rhythm.<br />Only useful cards.</h3><p>Full-screen vertical paging gives each result one moment of attention. There are no prompts, raw logs, heartbeats, or dashboard noise.</p><div><b>RESULTS</b><b>APPROVALS</b><b>FAILURES</b><b>MEDIA</b></div></article>
          <article data-reveal><span>02 · TASK PROFILE</span><h3>X-style conversation.<br />Real task context.</h3><p>See what you asked, what changed, what needs you now, and every meaningful human–Agent turn. Expand proof only when you need it.</p><div><b>TASK INPUT</b><b>LATEST CONCLUSION</b><b>NEXT ACTION</b><b>TIMELINE</b></div></article>
        </div>
      </section>

      <section className="ios-artifacts" id="artifacts">
        <div className="ios-section-copy ios-section-copy--dark" data-reveal>
          <span>ARTIFACTS ARE FIRST-CLASS</span>
          <h2>Don’t read that a file exists.<br /><em>Open the actual work.</em></h2>
          <p>Every output remains attached to the Agent, source Mac, and session that produced it. Switch the preview below to see how each artifact lives on iPhone.</p>
        </div>
        <div data-reveal><ArtifactShowcase /></div>
        <div className="ios-artifact-input" data-reveal>
          <span>IT WORKS BOTH WAYS</span>
          <h3>Send artifacts back to the Agent, too.</h3>
          <p>Attach photos, video, PDF, Markdown, text, CSV, JSON, Office documents, and source packages when creating or continuing a task.</p>
          <div><b>PHOTO</b><b>VIDEO</b><b>PDF</b><b>DOC</b><b>DATA</b><b>SOURCE</b><i>UP TO 10 PER TASK</i></div>
        </div>
      </section>

      <section className="ios-tour-section" id="demo">
        <div className="ios-section-copy" data-reveal>
          <span>TOUR THE REAL MOBILE PRODUCT</span>
          <h2>Not a companion viewer.<br />A complete control surface.</h2>
          <p>Explore the core iPhone surfaces. Each one is modeled on the product’s real interaction and information hierarchy.</p>
        </div>
        <div data-reveal><FeatureTour /></div>
      </section>

      <section className="ios-capabilities" id="capabilities">
        <div className="ios-capabilities-head" data-reveal>
          <span>EVERYTHING IN THE SYSTEM</span>
          <h2>The full mobile<br />attention loop.</h2>
          <p>From the first important signal to the next instruction—and through every network interruption in between.</p>
        </div>
        <div className="ios-capability-grid">
          {capabilities.map(([number, title, body], index) => (
            <article data-reveal style={{ "--reveal-delay": `${(index % 3) * 70}ms` } as React.CSSProperties} key={number}>
              <span>{number}</span><i>↗</i><h3>{title}</h3><p>{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="ios-routing" id="privacy">
        <div className="ios-routing-copy" data-reveal>
          <span>MULTIPLE MACS · ONE IPHONE</span>
          <h2>The phone is the product.<br /><em>Macs are its sources.</em></h2>
          <p>Each Mac remains the source of truth for its own Agent work. Zimlo keeps machine, project, runtime, and session identity intact as everything arrives on one iPhone.</p>
          <div><b>END-TO-END ENCRYPTED</b><b>NO REMOTE SHELL</b><b>NO READABLE CLOUD CONTENT</b></div>
        </div>
        <div className="ios-routing-map" data-reveal aria-label="Multiple Mac Agent sources connecting securely to one iPhone">
          <div className="ios-routing-phone"><BrandMark /><strong>YOUR IPHONE</strong><small>ONE ATTENTION LAYER</small></div>
          <div className="ios-routing-lines" aria-hidden="true"><i /><i /><i /></div>
          <div className="ios-routing-sources">
            <span><i />MACBOOK PRO<b>CODEX · ZIMLO</b></span>
            <span><i />MAC STUDIO<b>CLAUDE CODE · API</b></span>
            <span><i />WORK MAC<b>CODEX · CLIENT</b></span>
          </div>
        </div>
      </section>

      <section className="ios-setup" id="setup">
        <div className="ios-section-copy" data-reveal><span>ZERO-COMMAND ONBOARDING</span><h2>Three steps.<br />Then leave the desk.</h2></div>
        <div>{setupSteps.map(([number, title, body]) => <article data-reveal key={number}><span>{number}</span><h3>{title}</h3><p>{body}</p><i>→</i></article>)}</div>
      </section>

      <section className="ios-beta" id="beta">
        <div className="ios-beta-orbit" aria-hidden="true"><i /><i /><i /></div>
        <BrandMark />
        <span>IPHONE-FIRST BETA</span>
        <h2>Put your Agents<br />in your pocket.</h2>
        <p>Install the lightweight Mac companion, pair your iPhone, and keep the work moving from anywhere.</p>
        {waitlistLive ? <WaitlistForm source="beta" tone="acid" /> : <BetaDownload />}
      </section>

      <footer className="ios-footer">
        <a className="brand" href="#top"><BrandMark small /><span>ZIMLO</span></a>
        <p>The iPhone attention layer for AI work.</p>
        <nav aria-label="Footer navigation"><a href="https://github.com/rsgok/zimlo" rel="noopener noreferrer">GitHub</a><a href="/privacy">Privacy</a></nav>
        <span>© 2026 Zimlo</span>
      </footer>
    </main>
  );
}
