import assert from "node:assert/strict";
import test from "node:test";

/**
 * Integration tests for the built worker (dist/server/index.js): the
 * /api/waitlist route against an in-memory D1 stub, and the scheduled
 * retention sweep. Run after `npm run build` (see package.json "test").
 */

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

const ctx = { waitUntil() {}, passThroughOnException() {} };

/** Minimal in-memory D1 covering exactly the statements the worker issues. */
function createFakeD1() {
  const rows = [];
  const executed = [];
  let nextId = 1;
  return {
    rows,
    executed,
    prepare(sql) {
      const statement = {
        bind(...args) {
          statement.args = args;
          return statement;
        },
        args: [],
        async first() {
          executed.push(sql);
          assert.match(sql, /^SELECT id FROM waitlist_signups WHERE email = \? LIMIT 1$/);
          const row = rows.find((r) => r.email === statement.args[0]);
          return row ? { id: row.id } : null;
        },
        async run() {
          executed.push(sql);
          if (sql.startsWith("INSERT INTO waitlist_signups")) {
            const [email, source, consentVersion] = statement.args;
            if (rows.some((r) => r.email === email)) {
              throw new Error("UNIQUE constraint failed: waitlist_signups.email");
            }
            rows.push({ id: nextId++, email, status: "active", source, consent_version: consentVersion });
            return { meta: { changes: 1 } };
          }
          if (sql === "DELETE FROM waitlist_signups WHERE status != 'active'") {
            const before = rows.length;
            for (let i = rows.length - 1; i >= 0; i -= 1) {
              if (rows[i].status !== "active") rows.splice(i, 1);
            }
            return { meta: { changes: before - rows.length } };
          }
          if (sql === "DELETE FROM waitlist_signups WHERE status = 'active'") {
            const before = rows.length;
            for (let i = rows.length - 1; i >= 0; i -= 1) {
              if (rows[i].status === "active") rows.splice(i, 1);
            }
            return { meta: { changes: before - rows.length } };
          }
          throw new Error(`unexpected SQL: ${sql}`);
        },
      };
      return statement;
    },
  };
}

function waitlistEnv(db) {
  return {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    WAITLIST_ENABLED: "true",
    PRIVACY_CONTACT_VERIFIED: "true",
    DB: db,
  };
}

function validPayload(overrides = {}) {
  return {
    email: "Beta@Example.com",
    consent: true,
    source: "hero",
    website: "",
    startedAt: Date.now() - 10_000,
    ...overrides,
  };
}

function post(payload) {
  return new Request("http://localhost/api/waitlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

test("worker: signup lifecycle returns an indistinguishable 200 for new and duplicate", async () => {
  const worker = await loadWorker();
  const db = createFakeD1();
  const env = waitlistEnv(db);

  const created = await worker.fetch(post(validPayload()), env, ctx);
  assert.equal(created.status, 200);
  const createdBody = await created.json();

  const dupe = await worker.fetch(post(validPayload({ email: " beta@example.COM" })), env, ctx);
  assert.equal(dupe.status, 200);
  assert.deepEqual(await dupe.json(), createdBody, "duplicate copy must match the fresh-signup copy");

  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].email, "beta@example.com", "email is stored normalized");
  assert.equal(db.rows[0].status, "active");
  assert.match(db.rows[0].consent_version, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(Object.keys(db.rows[0]).sort(),
    ["consent_version", "email", "id", "source", "status"],
    "no IP/UA or other tracking columns are written");
});

test("worker: rejects bad input with 400 and stores nothing", async () => {
  const worker = await loadWorker();
  const db = createFakeD1();
  const env = waitlistEnv(db);

  assert.equal((await worker.fetch(post(validPayload({ email: "junk" })), env, ctx)).status, 400);
  assert.equal((await worker.fetch(post(validPayload({ consent: false })), env, ctx)).status, 400);
  assert.equal((await worker.fetch(post("{nope"), env, ctx)).status, 400);
  assert.equal(db.rows.length, 0);
});

test("worker: honeypot is ignored while a fast real signup is stored", async () => {
  const worker = await loadWorker();
  const db = createFakeD1();
  const env = waitlistEnv(db);

  const honey = await worker.fetch(post(validPayload({ website: "spammy" })), env, ctx);
  assert.equal(honey.status, 200);

  const fast = await worker.fetch(post(validPayload({ startedAt: Date.now() })), env, ctx);
  assert.equal(fast.status, 200);

  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].email, "beta@example.com");
});

test("worker: non-POST methods on /api/waitlist get 405", async () => {
  const worker = await loadWorker();
  const env = waitlistEnv(createFakeD1());
  const response = await worker.fetch(new Request("http://localhost/api/waitlist"), env, ctx);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
});

test("worker: gate requires every signal (flag, verified contact, D1)", async () => {
  const worker = await loadWorker();
  const db = createFakeD1();
  const full = waitlistEnv(db);
  for (const missing of ["WAITLIST_ENABLED", "PRIVACY_CONTACT_VERIFIED", "DB"]) {
    const env = { ...full, [missing]: undefined };
    const response = await worker.fetch(post(validPayload()), env, ctx);
    assert.equal(response.status, 404, `gate must stay closed without ${missing}`);
  }
  assert.equal(db.rows.length, 0);
});

test("scheduled: purges inactive stragglers without Beta config and idles without D1", async () => {
  const worker = await loadWorker();
  const db = createFakeD1();
  await worker.scheduled({ cron: "0 0 * * *", scheduledTime: Date.now() }, waitlistEnv(db), ctx);
  assert.ok(db.executed.includes("DELETE FROM waitlist_signups WHERE status != 'active'"));
  await worker.scheduled({ cron: "0 0 * * *", scheduledTime: Date.now() }, {}, ctx);
});

test("scheduled: keeps active rows during the 90-day grace period", async () => {
  const worker = await loadWorker();
  const db = createFakeD1();
  db.rows.push(
    { id: 1, email: "a@example.com", status: "active", source: "hero", consent_version: "2026-07-28" },
    { id: 2, email: "b@example.com", status: "unsubscribed", source: "beta", consent_version: "2026-07-28" },
  );
  const env = { ...waitlistEnv(db), WAITLIST_BETA_ENDED_AT: new Date(Date.now() - 30 * 86400_000).toISOString() };
  await worker.scheduled({ cron: "0 0 * * *", scheduledTime: Date.now() }, env, ctx);
  assert.deepEqual(db.rows.map((r) => r.email), ["a@example.com"],
    "active rows survive inside the grace period; non-active stragglers are purged");
});

test("scheduled: purges active rows 90 days after the Beta ends", async () => {
  const worker = await loadWorker();
  const db = createFakeD1();
  db.rows.push({ id: 1, email: "a@example.com", status: "active", source: "hero", consent_version: "2026-07-28" });
  const env = { ...waitlistEnv(db), WAITLIST_BETA_ENDED_AT: new Date(Date.now() - 91 * 86400_000).toISOString() };
  await worker.scheduled({ cron: "0 0 * * *", scheduledTime: Date.now() }, env, ctx);
  assert.equal(db.rows.length, 0);
  assert.ok(db.executed.includes("DELETE FROM waitlist_signups WHERE status = 'active'"));
});
