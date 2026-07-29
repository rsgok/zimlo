# Zimlo Landing Page v2

A dependency-free redesign of the Zimlo landing page — static HTML/CSS/JS, no build step.

## Preview

```sh
cd landing-page-v2
python3 -m http.server 8765   # then open http://localhost:8765/
```

Any static file server works (`npx serve`, etc.). Do not open `index.html` via
`file://` — the Beta button fetch and web fonts need an HTTP origin.

## What's inside

- `index.html` — all copy and structure
- `styles.css` — the whole design system (dark, Space Grotesk / Inter / JetBrains Mono)
- `main.js` — live feed mock, scroll-driven hero, scroll reveal, Beta download button
- `assets/` — favicon, touch icon, OG image (reused from `landing-page/public`)

## Behavior notes

- **Scroll-driven hero (desktop, ≥1021px):** the hero pins (`position: sticky`,
  400vh) and page scroll flips through the four feed cards — only after the last
  card does the page move on to the next section. No wheel-event hijacking;
  native scrolling stays intact.
- **Mobile / narrow screens:** the feed autoplays every 4.8s and supports
  vertical swipe (up = next), dots, and arrows. Autoplay pauses on hover/focus.
- `prefers-reduced-motion` disables autoplay, the scroll-driven mode, and all
  animation.
- The Beta button calls
  `https://zimlo-cloud.zimlo.workers.dev/releases/macos/latest.json`; when a
  release manifest exists it turns into "Download for Mac", otherwise it stays
  disabled as "Beta opening soon".

## Test hooks

- `?snap=1` — deterministic page (no animations, all reveals visible,
  scroll-driven mode off) for full-page screenshots.
- `?scrollto=N` — jump to scroll offset N after load, to capture
  scroll-driven states.

## Deploy

It's a plain static site — drop it on Cloudflare Pages/Workers Assets, Netlify,
or any static host. For Cloudflare Workers static assets:

```sh
npx wrangler deploy --config wrangler.toml
```

Remember to make `og:image` / `twitter:image` absolute URLs once the domain is set.
