import assert from "node:assert/strict";
import { glob, readFile } from "node:fs/promises";
import test from "node:test";

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

function baseEnv(extra = {}) {
  return {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    ...extra,
  };
}

const ctx = { waitUntil() {}, passThroughOnException() {} };

async function render(worker, path = "/", env = baseEnv()) {
  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
    env,
    ctx,
  );
}

test("server-renders the finished Zimlo landing page", async () => {
  const worker = await loadWorker();
  const response = await render(worker, "/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Zimlo — The edited feed for your AI work<\/title>/i);
  assert.match(html, /Your AI work/);
  assert.match(html, /edited down to what matters/);
  assert.match(html, /Browse like TikTok/);
  assert.match(html, /Respond like X/);
  assert.match(html, /zimlo-feed-mobile-en\.png/);
  assert.match(html, /zimlo-feed-desktop-en\.png/);
  assert.match(html, /End-to-end encrypted/);
  assert.match(html, /ZERO COMMAND ONBOARDING/);
  assert.match(html, /Signed Mac download and iPhone TestFlight access will appear here/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("hero mocks use neutral labels, not PRODUCT MOCK stamps", async () => {
  const worker = await loadWorker();
  const html = await (await render(worker, "/")).text();
  assert.match(html, /393 × 852 · ONE CARD AT A TIME/);
  assert.match(html, /ENGLISH FEED PREVIEW/);
  assert.match(html, /ENCRYPTED · LOCAL FIRST/);
  assert.doesNotMatch(html, /PRODUCT[- ]ACCURATE MOCK|PRODUCT MOCK/);
});

test("beta area tolerates every release state (loading/closed/error/ready)", async () => {
  const worker = await loadWorker();
  const html = await (await render(worker, "/")).text();
  // SSR emits the loading state; client may swap in closed/error/ready later.
  assert.match(
    html,
    /Checking for the Beta|Beta opening soon|Could not reach the release server|Retry Beta check|Download for Mac/,
  );
});

test("homepage has a #demo section with real scenario cards", async () => {
  const worker = await loadWorker();
  const html = await (await render(worker, "/")).text();
  assert.match(html, /id="demo"/);
  assert.match(html, /Real cards/);
  // Result card
  assert.match(html, /PR #128 is ready to merge/);
  assert.match(html, /43 tests passed · 0 unresolved review threads/);
  // Approval card
  assert.match(html, /Approve a low-risk command\?/);
  // Failure card
  assert.match(html, /Tests failed in the auth flow/);
  assert.match(html, /src\/auth\/session\.test\.ts/);
  // Hero "See how it works" and the beta section both route to #demo
  assert.match(html, /See how it works<\/a>/);
  assert.ok((html.match(/href="#demo"/g) ?? []).length >= 2, "expected >=2 links to #demo");
});

test("footer links to GitHub and the privacy policy", async () => {
  const worker = await loadWorker();
  const html = await (await render(worker, "/")).text();
  assert.match(html, /href="https:\/\/github\.com\/rsgok\/zimlo"/);
  assert.match(html, /href="\/privacy"/);
  assert.match(html, /Privacy policy/);
});

test("Geist font variables reach the rendered page", async () => {
  const worker = await loadWorker();
  const html = await (await render(worker, "/")).text();
  assert.match(html, /--font-geist-sans/);
  assert.match(html, /--font-geist-mono/);
});

test("built CSS uses the Geist stack and respects the 11px size floor", async () => {
  const cssFiles = [];
  for await (const entry of glob("assets/*.css", { cwd: new URL("../dist/client/", import.meta.url) })) {
    cssFiles.push(entry);
  }
  assert.ok(cssFiles.length > 0, "expected at least one built CSS asset");
  const css = (await Promise.all(
    cssFiles.map((file) => readFile(new URL(`../dist/client/${file}`, import.meta.url), "utf8")),
  )).join("\n");

  assert.match(css, /font-family:\s*var\(--font-geist-sans\)/);
  assert.doesNotMatch(css, /font-family:\s*Arial\b/);
  assert.doesNotMatch(css, /font-size:\s*(?:[1-9]|10)px\b/, "micro text below 11px is banned");
});

test("waitlist stays hidden while the gate is off (default)", async () => {
  const worker = await loadWorker();
  const html = await (await render(worker, "/")).text();
  assert.doesNotMatch(html, /data-waitlist-form/);
});

test("waitlist form renders in hero and beta sections when the gate is on", async () => {
  const worker = await loadWorker();
  const fakeDb = { prepare: () => { throw new Error("DB must not be queried during render"); } };
  const html = await (await render(worker, "/", baseEnv({
    WAITLIST_ENABLED: "true",
    PRIVACY_CONTACT_VERIFIED: "true",
    DB: fakeDb,
  }))).text();
  assert.match(html, /data-waitlist-form="hero"/);
  assert.match(html, /data-waitlist-form="beta"/);
  assert.match(html, /Email address/);
  assert.match(html, /name="website"/); // honeypot
  assert.match(html, /privacy policy/);
  // The download button block is replaced by the form in this mode
  assert.doesNotMatch(html, /Join the Mac Beta/);
});

test("/privacy page documents collection, retention, and opt-out", async () => {
  const worker = await loadWorker();
  const response = await render(worker, "/privacy");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /privacy@zimlo\.app/);
  assert.match(html, /90 days/);
  assert.match(html, /unsubscribe/i);
  assert.match(html, /do not store IP addresses/i);
});

test("/product-demo is gone and 308-redirects to /", async () => {
  const worker = await loadWorker();
  for (const path of ["/product-demo", "/product-demo/"]) {
    const response = await render(worker, path);
    assert.equal(response.status, 308, path);
    assert.match(response.headers.get("location") ?? "", /\/$/);
  }
});

test("POST /api/waitlist is 404 while the gate is off", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("http://localhost/api/waitlist", { method: "POST", body: "{}" }),
    baseEnv(),
    ctx,
  );
  assert.equal(response.status, 404);
});
