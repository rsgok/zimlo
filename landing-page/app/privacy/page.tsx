import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy policy — Zimlo",
  description:
    "What the Zimlo Beta waitlist collects (your email and nothing else), why, how long it is kept, and how to opt out.",
};

const sections = [
  {
    title: "What we collect",
    body: [
      "If you join the Beta waitlist, we store exactly two things: your email address (normalized to lowercase) and a coarse note of where you signed up (for example, “hero” or “beta”). We also store which version of this consent text you agreed to.",
      "We do not store IP addresses, browser user agents, referrers, cookies for tracking, or any analytics identifiers. There is no advertising on this site and no third-party trackers.",
    ],
  },
  {
    title: "Why we collect it",
    body: [
      "Your email is used for exactly one purpose: to notify you when the Zimlo Mac Beta opens. No newsletter, no product marketing drip, no sharing with third parties.",
    ],
  },
  {
    title: "How long we keep it",
    body: [
      "Waitlist records are kept while the Beta program is running. If you have not converted within 90 days after the Beta program ends, your record is deleted automatically by a scheduled cleanup job that logs only how many rows it removed — never which ones.",
      "If you convert to the Beta or unsubscribe, your waitlist record is deleted immediately.",
    ],
  },
  {
    title: "How to opt out",
    body: [
      "Email privacy@zimlo.app from the address you registered with, or reply “unsubscribe” to any email we send you, and your record will be deleted.",
    ],
  },
  {
    title: "The product itself",
    body: [
      "Zimlo is end-to-end encrypted by design: task text, code, and results never touch Zimlo Cloud in readable form. Cloudflare relays ciphertext only, and your Mac remains the only source of truth.",
    ],
  },
  {
    title: "Contact",
    body: [
      "Questions about this policy or your data: privacy@zimlo.app.",
    ],
  },
];

export default function PrivacyPage() {
  return (
    <main className="doc-page">
      <header className="doc-header">
        <Link className="brand" href="/" aria-label="Back to the Zimlo home page">
          <span className="brand-mark brand-mark--small" aria-hidden="true"><span>✦</span></span>
          <span>ZIMLO</span>
        </Link>
      </header>

      <article className="doc-main">
        <span className="section-kicker">PRIVACY POLICY</span>
        <h1>Your email. One notification. Nothing else.</h1>
        <p className="doc-lede">
          This policy covers the Zimlo landing page and the Mac Beta waitlist. Last updated July 2026.
        </p>

        {sections.map((section) => (
          <section key={section.title}>
            <h2>{section.title}</h2>
            {section.body.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </section>
        ))}

        <p className="doc-back">
          <Link href="/">← Back to zimlo.app</Link>
        </p>
      </article>
    </main>
  );
}
