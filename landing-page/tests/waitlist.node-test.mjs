import assert from "node:assert/strict";
import test from "node:test";

import {
  handleWaitlistPost,
  isValidEmail,
  isWaitlistEnabled,
  normalizeEmail,
  parseBetaEndedAt,
  parseWaitlistPayload,
  RETENTION_DAYS_AFTER_BETA_END,
  runWaitlistRetention,
  WAITLIST_SUCCESS_MESSAGE,
} from "../worker/waitlist.mjs";

const NOW = Date.now();

function validPayload(overrides = {}) {
  return {
    email: "Kai@Example.com ",
    consent: true,
    source: "hero",
    website: "",
    startedAt: NOW - 10_000,
    ...overrides,
  };
}

test("normalizeEmail trims and lowercases", () => {
  assert.equal(normalizeEmail("  Kai@Example.COM "), "kai@example.com");
  assert.equal(normalizeEmail(""), "");
  assert.equal(normalizeEmail(undefined), "");
  assert.equal(normalizeEmail(42), "");
});

test("isValidEmail accepts ordinary addresses and rejects junk", () => {
  assert.ok(isValidEmail("kai@example.com"));
  assert.ok(isValidEmail("kai.z+tag@sub.example.co"));
  assert.ok(!isValidEmail(""));
  assert.ok(!isValidEmail("not-an-email"));
  assert.ok(!isValidEmail("a@b"));
  assert.ok(!isValidEmail("@example.com"));
  assert.ok(!isValidEmail("kai@"));
  assert.ok(!isValidEmail("kai @example.com"));
});

test("parseWaitlistPayload accepts a valid signup and normalizes it", () => {
  const result = parseWaitlistPayload(validPayload(), NOW);
  assert.deepEqual(result, {
    kind: "signup",
    signup: { email: "kai@example.com", source: "hero" },
  });
});

test("parseWaitlistPayload falls back to a generic source tag", () => {
  const result = parseWaitlistPayload(validPayload({ source: "evil<script>" }), NOW);
  assert.equal(result.kind, "signup");
  assert.equal(result.signup.source, "landing");
});

test("parseWaitlistPayload rejects invalid email and missing consent", () => {
  assert.equal(parseWaitlistPayload(validPayload({ email: "nope" }), NOW).kind, "invalid");
  assert.equal(parseWaitlistPayload(validPayload({ consent: false }), NOW).kind, "invalid");
  assert.equal(parseWaitlistPayload(validPayload({ consent: "yes" }), NOW).kind, "invalid");
  assert.equal(parseWaitlistPayload(null, NOW).kind, "invalid");
  assert.equal(parseWaitlistPayload([], NOW).kind, "invalid");
});

test("parseWaitlistPayload silently ignores honeypot fills", () => {
  const result = parseWaitlistPayload(validPayload({ website: "https://spam.example" }), NOW);
  assert.equal(result.kind, "ignore");
});

test("parseWaitlistPayload accepts fast submissions because dwell time is client-controlled", () => {
  assert.equal(parseWaitlistPayload(validPayload({ startedAt: NOW }), NOW).kind, "signup");
  assert.equal(parseWaitlistPayload(validPayload({ startedAt: NOW + 60_000 }), NOW).kind, "signup");
});

test("parseWaitlistPayload rejects missing/invalid startedAt", () => {
  assert.equal(parseWaitlistPayload(validPayload({ startedAt: undefined }), NOW).kind, "invalid");
  assert.equal(parseWaitlistPayload(validPayload({ startedAt: "now" }), NOW).kind, "invalid");
});

test("isWaitlistEnabled requires flag + verified contact + D1 binding", () => {
  const db = {};
  assert.ok(isWaitlistEnabled({ WAITLIST_ENABLED: "true", PRIVACY_CONTACT_VERIFIED: "true", DB: db }));
  assert.ok(!isWaitlistEnabled(undefined));
  assert.ok(!isWaitlistEnabled({}));
  assert.ok(!isWaitlistEnabled({ WAITLIST_ENABLED: "true", PRIVACY_CONTACT_VERIFIED: "true" }));
  assert.ok(!isWaitlistEnabled({ WAITLIST_ENABLED: "true", DB: db }));
  assert.ok(!isWaitlistEnabled({ PRIVACY_CONTACT_VERIFIED: "true", DB: db }));
  assert.ok(!isWaitlistEnabled({ WAITLIST_ENABLED: "yes", PRIVACY_CONTACT_VERIFIED: "true", DB: db }));
});

function memoryStore() {
  const rows = [];
  return {
    rows,
    async findByEmail(email) {
      return rows.some((row) => row.email === email);
    },
    async insert(signup) {
      if (rows.some((row) => row.email === signup.email)) {
        throw new Error("UNIQUE constraint failed: waitlist_signups.email");
      }
      rows.push(signup);
    },
  };
}

function post(body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("http://localhost/api/waitlist", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: text,
  });
}

test("handleWaitlistPost: new and duplicate signups return the same 200 response", async () => {
  const store = memoryStore();
  const first = await handleWaitlistPost(post(validPayload()), store, NOW);
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.message, WAITLIST_SUCCESS_MESSAGE);

  const second = await handleWaitlistPost(post(validPayload({ email: "kai@example.COM" })), store, NOW);
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.deepEqual(secondBody, firstBody, "duplicate must return the same copy as a fresh signup");
  assert.equal(store.rows.length, 1);
});

test("handleWaitlistPost: unique-violation race degrades to the 200 duplicate path", async () => {
  const store = memoryStore();
  store.findByEmail = async () => false; // lie, forcing the insert race
  await store.insert({ email: "kai@example.com", source: "hero" });
  const response = await handleWaitlistPost(post(validPayload()), store, NOW);
  assert.equal(response.status, 200);
  assert.equal(store.rows.length, 1);
});

test("handleWaitlistPost: invalid email / missing consent → 400, nothing stored", async () => {
  const store = memoryStore();
  assert.equal((await handleWaitlistPost(post(validPayload({ email: "bad" })), store, NOW)).status, 400);
  assert.equal((await handleWaitlistPost(post(validPayload({ consent: false })), store, NOW)).status, 400);
  assert.equal(store.rows.length, 0);
});

test("handleWaitlistPost: honeypot is ignored but a fast real signup is stored", async () => {
  const store = memoryStore();
  const honey = await handleWaitlistPost(post(validPayload({ website: "x" })), store, NOW);
  assert.equal(honey.status, 200);
  assert.equal((await honey.json()).message, WAITLIST_SUCCESS_MESSAGE);

  const fast = await handleWaitlistPost(post(validPayload({ startedAt: NOW })), store, NOW);
  assert.equal(fast.status, 200);

  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0].email, "kai@example.com");
});

test("handleWaitlistPost: malformed JSON → 400, oversized bodies → 413", async () => {
  const store = memoryStore();
  assert.equal((await handleWaitlistPost(post("{not json"), store, NOW)).status, 400);

  const big = JSON.stringify({ email: "a@b.co", pad: "x".repeat(5000) });
  assert.equal((await handleWaitlistPost(post(big), store, NOW)).status, 413);

  const small = post(validPayload(), { "content-length": "999999" });
  assert.equal((await handleWaitlistPost(small, store, NOW)).status, 413);
  assert.equal(store.rows.length, 0);
});

test("parseBetaEndedAt parses ISO dates and rejects garbage", () => {
  assert.equal(parseBetaEndedAt(undefined), null);
  assert.equal(parseBetaEndedAt(""), null);
  assert.equal(parseBetaEndedAt("not a date"), null);
  assert.equal(parseBetaEndedAt("2026-10-01"), Date.parse("2026-10-01"));
  assert.equal(parseBetaEndedAt("2026-10-01T00:00:00Z"), Date.parse("2026-10-01T00:00:00Z"));
});

function recordingDb() {
  const statements = [];
  return {
    statements,
    prepare(sql) {
      statements.push(sql);
      const isActiveDelete = sql === "DELETE FROM waitlist_signups WHERE status = 'active'";
      return {
        bind() {
          return this;
        },
        async run() {
          return { meta: { changes: isActiveDelete ? 7 : 2 } };
        },
      };
    },
  };
}

test("runWaitlistRetention idles when the Beta end date is unset", async () => {
  const db = recordingDb();
  const result = await runWaitlistRetention(db, { betaEndedAt: null, now: NOW });
  assert.equal(result.sweepRan, false);
  assert.equal(result.deletedExpired, 0);
  assert.deepEqual(db.statements, ["DELETE FROM waitlist_signups WHERE status != 'active'"]);
});

test("runWaitlistRetention waits for the 90-day grace period", async () => {
  const db = recordingDb();
  const betaEndedAt = NOW - (RETENTION_DAYS_AFTER_BETA_END - 1) * 24 * 60 * 60 * 1000;
  const result = await runWaitlistRetention(db, { betaEndedAt, now: NOW });
  assert.equal(result.sweepRan, false);
  assert.equal(result.deletedExpired, 0);
  assert.ok(!db.statements.includes("DELETE FROM waitlist_signups WHERE status = 'active'"));
});

test("runWaitlistRetention purges active rows after the grace period", async () => {
  const db = recordingDb();
  const betaEndedAt = NOW - (RETENTION_DAYS_AFTER_BETA_END + 1) * 24 * 60 * 60 * 1000;
  const result = await runWaitlistRetention(db, { betaEndedAt, now: NOW });
  assert.equal(result.sweepRan, true);
  assert.equal(result.deletedExpired, 7);
  assert.equal(result.deletedInactive, 2);
});
