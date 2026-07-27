/* eslint-disable @next/next/no-img-element */
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Zimlo Product Demo",
  robots: { index: false, follow: false },
};

function ProductMark() {
  return <img src="/avatar-zimlo.png" width={30} height={30} alt="" />;
}

export default function ProductDemo() {
  return (
    <main className="product-demo">
      <header className="demo-topbar">
        <ProductMark />
        <strong>Feed</strong>
        <span><i /> Local</span>
      </header>

      <section className="demo-feed-stage">
        <article className="demo-feed-card">
          <div className="demo-card-topline">
            <div><span>RESULT</span><b>ZIMLO</b></div>
            <code>01 / 02</code>
          </div>

          <div className="demo-card-copy">
            <time>JUST NOW</time>
            <h1>Your AI work, edited down to what matters.</h1>
            <p>
              Zimlo turns agent activity into one calm, swipeable feed—so you see
              the conclusion, the proof, and the next move without reading the transcript.
            </p>
            <ul>
              <li>One meaningful card fills the viewport</li>
              <li>Important work stays; routine activity disappears</li>
            </ul>
            <aside><span>NEXT</span>Review the result, open its thread, or keep scrolling.</aside>
          </div>

          <footer className="demo-card-footer">
            <div className="demo-session-meta">
              <span className="demo-provider">✦</span>
              <span className="demo-agent"><img src="/avatar-zimlo.png" width={20} height={20} alt="" />Zimlo</span>
              <strong>NEEDS YOU</strong>
            </div>
          </footer>
        </article>
      </section>

      <nav className="demo-bottom-nav" aria-label="Product preview navigation">
        <span className="is-active"><b>◫</b>Feed</span>
        <span><b>◎</b>Tasks</span>
        <span className="demo-new-task"><b>＋</b>New task</span>
        <span><b>○</b>Agents</span>
        <span><img src="/avatar-user.png" width={22} height={22} alt="" />Settings</span>
      </nav>
    </main>
  );
}
