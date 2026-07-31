/**
 * Waitlist backend logic for the Zimlo landing page.
 *
 * Plain ESM (no TypeScript, no runtime deps) on purpose: the worker entry
 * imports it for `POST /api/waitlist` and the daily retention sweep, and
 * `node --test` imports it directly for unit tests without a build step.
 *
 * Privacy rules baked in here:
 * - Only a normalized email, a coarse `source` tag, and the consent version
 *   are stored. Never store IPs, user agents, or timestamps beyond what the
 *   schema defaults to.
 * - New and duplicate signups return the SAME message and status so the
 *   endpoint cannot be used to probe whether an address is registered.
 * - Honeypot hits are silently accepted (same success copy) but never touch
 *   the database. Client-controlled dwell time is never used to drop signups.
 */

export const WAITLIST_CONSENT_VERSION = "2026-07-28";
export const WAITLIST_SUCCESS_MESSAGE =
  "You're on the list. We'll email you once when the Mac Beta opens.";

export const MAX_BODY_BYTES = 4096;
export const RETENTION_DAYS_AFTER_BETA_END = 90;

const ALLOWED_SOURCES = new Set(["hero", "beta", "privacy"]);

/**
 * The waitlist is gated OFF by default. Do not enable it until ALL of these
 * are true in the deployed worker environment:
 *   WAITLIST_ENABLED="true"           – explicit product sign-off
 *   PRIVACY_CONTACT_VERIFIED="true"   – privacy@zimlo.app is verified and can
 *                                       actually receive mail (the /privacy
 *                                       page promises this contact)
 *   DB                                – the D1 binding with the
 *                                       waitlist_signups migration applied
 * @param {Record<string, unknown> | undefined | null} env
 */
export function isWaitlistEnabled(env) {
  return Boolean(env)
    && env.WAITLIST_ENABLED === "true"
    && env.PRIVACY_CONTACT_VERIFIED === "true"
    && Boolean(env.DB);
}

/**
 * @param {unknown} raw
 * @returns {string} trimmed, lower-cased email ("" for non-strings)
 */
export function normalizeEmail(raw) {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

/** @param {string} email */
export function isValidEmail(email) {
  return typeof email === "string"
    && email.length <= 254
    && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(email);
}

/**
 * Validates a parsed JSON body.
 * @param {unknown} value parsed JSON
 * @returns {{ kind: "signup", signup: { email: string, source: string } }
 *   | { kind: "ignore" }   // bot heuristics: accept silently, store nothing
 *   | { kind: "invalid", error: string }}
 */
export function parseWaitlistPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "invalid", error: "Invalid request body." };
  }
  const payload = /** @type {Record<string, unknown>} */ (value);

  // Honeypot: real users never see (or fill) the `website` field.
  if (typeof payload.website === "string" && payload.website.length > 0) {
    return { kind: "ignore" };
  }

  // Keep the field as a structural signal, but never reject a real signup for
  // submitting quickly: startedAt is client-controlled and autofill can be instant.
  const startedAt = typeof payload.startedAt === "number" ? payload.startedAt : NaN;
  if (!Number.isFinite(startedAt)) {
    return { kind: "invalid", error: "Invalid submission. Reload the page and try again." };
  }

  const email = normalizeEmail(payload.email);
  if (!isValidEmail(email)) {
    return { kind: "invalid", error: "Enter a valid email address." };
  }
  if (payload.consent !== true) {
    return { kind: "invalid", error: "Please agree to be contacted about the Beta." };
  }

  const source = typeof payload.source === "string" && ALLOWED_SOURCES.has(payload.source)
    ? payload.source
    : "landing";
  return { kind: "signup", signup: { email, source } };
}

/**
 * @param {unknown} error
 * @returns {boolean} true for D1/SQLite unique-constraint violations
 */
function isUniqueViolation(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed/i.test(message);
}

/**
 * Storage abstraction so the request handler stays unit-testable.
 * @typedef {{ findByEmail(email: string): Promise<boolean>,
 *   insert(signup: { email: string, source: string }): Promise<void> }} WaitlistStore
 */

/**
 * D1-backed store. SQL matches drizzle/migration `0000_*.sql`; the Drizzle
 * schema in db/schema.ts is the source of truth for DDL, raw statements keep
 * the runtime path dependency-free.
 * @param {import("./index").D1DatabaseLike} db
 * @returns {WaitlistStore}
 */
export function createD1WaitlistStore(db) {
  return {
    async findByEmail(email) {
      const row = await db
        .prepare("SELECT id FROM waitlist_signups WHERE email = ? LIMIT 1")
        .bind(email)
        .first();
      return row !== null && row !== undefined;
    },
    async insert(signup) {
      await db
        .prepare("INSERT INTO waitlist_signups (email, status, source, consent_version) VALUES (?, 'active', ?, ?)")
        .bind(signup.email, signup.source, WAITLIST_CONSENT_VERSION)
        .run();
    },
  };
}

/** @param {unknown} body @param {number} status */
function json(body, status) {
  return Response.json(body, { status });
}

/**
 * Handles POST /api/waitlist against any WaitlistStore.
 * @param {Request} request
 * @param {WaitlistStore} store
 * @param {number} [now]
 */
export async function handleWaitlistPost(request, store, now = Date.now()) {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return json({ error: "Request too large." }, 413);
  }

  let text;
  try {
    text = await request.text();
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }
  if (text.length > MAX_BODY_BYTES) {
    return json({ error: "Request too large." }, 413);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }

  const result = parseWaitlistPayload(parsed, now);
  if (result.kind === "invalid") {
    return json({ error: result.error }, 400);
  }
  if (result.kind === "ignore") {
    // Bot heuristics: same copy as a real signup, nothing stored.
    return json({ ok: true, message: WAITLIST_SUCCESS_MESSAGE }, 200);
  }

  if (await store.findByEmail(result.signup.email)) {
    // Duplicate: identical copy and status to a fresh signup.
    return json({ ok: true, message: WAITLIST_SUCCESS_MESSAGE }, 200);
  }
  try {
    await store.insert(result.signup);
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Lost an insert race on the unique index — still a duplicate.
      return json({ ok: true, message: WAITLIST_SUCCESS_MESSAGE }, 200);
    }
    throw error;
  }
  return json({ ok: true, message: WAITLIST_SUCCESS_MESSAGE }, 200);
}

/**
 * Parses the WAITLIST_BETA_ENDED_AT config value (ISO 8601 date/datetime).
 * @param {unknown} value
 * @returns {number | null} ms timestamp, or null when unset/unparseable
 */
export function parseBetaEndedAt(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/**
 * Daily retention sweep.
 *
 * - Converted/unsubscribed rows are deleted immediately when the action
 *   happens (nothing keeps them); any stragglers are purged here as a safety
 *   net, on every run.
 * - Once the Beta has ended (WAITLIST_BETA_ENDED_AT) and the
 *   RETENTION_DAYS_AFTER_BETA_END grace period has passed, every still-active
 *   (never converted) row is deleted.
 * - Config unset → the sweep is a no-op apart from the straggler purge.
 * - Returns only counts; callers must log counts and the run time, never
 *   email addresses.
 *
 * @param {import("./index").D1DatabaseLike} db
 * @param {{ betaEndedAt: number | null, now?: number }} options
 */
export async function runWaitlistRetention(db, { betaEndedAt, now = Date.now() }) {
  const inactive = await db
    .prepare("DELETE FROM waitlist_signups WHERE status != 'active'")
    .run();
  const deletedInactive = Number(inactive?.meta?.changes ?? 0);

  let deletedExpired = 0;
  let sweepRan = false;
  if (betaEndedAt !== null) {
    const cutoff = betaEndedAt + RETENTION_DAYS_AFTER_BETA_END * 24 * 60 * 60 * 1000;
    if (now >= cutoff) {
      const expired = await db
        .prepare("DELETE FROM waitlist_signups WHERE status = 'active'")
        .run();
      deletedExpired = Number(expired?.meta?.changes ?? 0);
      sweepRan = true;
    }
  }
  return { deletedInactive, deletedExpired, sweepRan };
}
