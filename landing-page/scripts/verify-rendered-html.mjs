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
  assert.match(html, /<title>Zimlo — Your Agents keep working\. Your iPhone keeps you in control\.<\/title>/i);
  assert.match(html, /Your Agents/);
  assert.match(html, /Your iPhone/);
  assert.match(html, /TikTok-style main Feed/);
  assert.match(html, /X-style profile for every session/);
  assert.match(html, /THE TWO EXPERIENCES WE ARE PROUD OF/);
  assert.match(html, /ARTIFACTS ARE FIRST-CLASS/);
  assert.match(html, /MULTIPLE MACS · ONE IPHONE/);
  assert.match(html, /MACBOOK PRO/);
  assert.match(html, /MAC STUDIO/);
  assert.match(html, /WORK MAC/);
  assert.match(html, /END-TO-END ENCRYPTED/);
  assert.match(html, /ZERO-COMMAND ONBOARDING/);
  assert.match(html, /Signed Mac download and iPhone TestFlight access will appear here/);
  assert.doesNotMatch(html, /zimlo-feed-(?:mobile|desktop)-en\.png/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("homepage presents rich outputs and multiple machine sources as first-class capabilities", async () => {
  const worker = await loadWorker();
  const html = await (await render(worker, "/")).text();
  assert.match(html, /id="capabilities"/);
  assert.match(html, /Image album/);
  assert.match(html, /Inline video/);
  assert.match(html, /Markdown \+ text/);
  assert.match(html, /PDF \+ files/);
  assert.match(html, /Send artifacts back to the Agent/);
  assert.match(html, /TikTok-style Feed/);
  assert.match(html, /X-style Task Profile/);
  assert.match(html, /Offline outbox/);
  assert.match(html, /Secure pairing/);
  assert.match(html, /Smart notifications/);
});

test("hero is iPhone-first and shows the flagship mobile surfaces", async () => {
  const worker = await loadWorker();
  const html = await (await render(worker, "/")).text();
  assert.match(html, /ZIMLO FOR IPHONE/);
  assert.match(html, /aria-label="Zimlo running on iPhone"/);
  assert.match(html, /FULL-SCREEN FEED/);
  assert.match(html, /Task Profile/);
  assert.match(html, /Conversation/);
  assert.match(html, /IPHONE RUNS THE EXPERIENCE/);
  assert.match(html, /MACS RUN THE WORK/);
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

test("homepage has a #demo section that tours the complete iOS control surface", async () => {
  const worker = await loadWorker();
  const html = await (await render(worker, "/")).text();
  assert.match(html, /id="demo"/);
  assert.match(html, /TOUR THE REAL MOBILE PRODUCT/);
  assert.match(html, /Attention Feed/);
  assert.match(html, /Task Profile/);
  assert.match(html, /Artifacts/);
  assert.match(html, /Create \+ reply/);
  assert.match(html, /Tasks \+ Agents/);
  assert.match(html, /Reliable control/);
  assert.match(html, /persistent queues/i);
});

test("footer links to GitHub and the privacy policy", async () => {
  const worker = await loadWorker();
  const html = await (await render(worker, "/")).text();
  assert.match(html, /href="https:\/\/github\.com\/rsgok\/zimlo"/);
  assert.match(html, /href="\/privacy"/);
  assert.match(html, />Privacy<\/a>/);
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
