import { createPrivateKey, createPublicKey, randomUUID, sign, verify } from "node:crypto";
import { connect } from "node:http2";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";

interface RegisterBody {
  platform?: string;
  token?: string;
  publicKey?: string;
}

interface SendBody {
  endpoint?: string;
  kind?: "approval" | "failure" | "review";
  collapseId?: string;
  alert?: { title?: string; body?: string };
  route?: { ephemeralPublicKey?: string; nonce?: string; ciphertext?: string };
}

function base64URL(value: Uint8Array | string): string {
  return Buffer.from(value).toString("base64url");
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value.replaceAll("\\n", "\n");
}

const databasePath = process.env.ZIMLO_PUSH_DATABASE ?? "/data/push-relay.sqlite";
mkdirSync(dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);
database.exec(`
  PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS devices (
    endpoint TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    public_key TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const registrationSecret = required("ZIMLO_PUSH_REGISTRATION_SECRET");
const senderPublicKey = createPublicKey(required("ZIMLO_SENDER_PUBLIC_KEY_PEM"));
const apnsPrivateKey = createPrivateKey(required("APNS_PRIVATE_KEY_PEM"));
const apnsKeyId = required("APNS_KEY_ID");
const apnsTeamId = required("APNS_TEAM_ID");
const apnsTopic = required("APNS_TOPIC");
const apnsOrigin = process.env.APNS_ENVIRONMENT === "production"
  ? "https://api.push.apple.com"
  : "https://api.sandbox.push.apple.com";

let cachedJWT: { token: string; expiresAt: number } | null = null;

function apnsJWT(): string {
  if (cachedJWT && cachedJWT.expiresAt > Date.now()) return cachedJWT.token;
  const issuedAt = Math.floor(Date.now() / 1_000);
  const header = base64URL(JSON.stringify({ alg: "ES256", kid: apnsKeyId }));
  const claims = base64URL(JSON.stringify({ iss: apnsTeamId, iat: issuedAt }));
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key: apnsPrivateKey, dsaEncoding: "ieee-p1363" });
  const token = `${header}.${claims}.${base64URL(signature)}`;
  cachedJWT = { token, expiresAt: Date.now() + 50 * 60 * 1_000 };
  return token;
}

async function sendAPNs(token: string, body: SendBody): Promise<number> {
  const client = connect(apnsOrigin);
  return new Promise<number>((resolve, reject) => {
    client.once("error", reject);
    const request = client.request({
      ":method": "POST",
      ":path": `/3/device/${token}`,
      authorization: `bearer ${apnsJWT()}`,
      "apns-topic": apnsTopic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-collapse-id": body.collapseId?.slice(0, 64) ?? randomUUID(),
    });
    request.setEncoding("utf8");
    request.on("response", (headers) => {
      const status = Number(headers[":status"] ?? 500);
      request.resume();
      request.once("end", () => {
        client.close();
        resolve(status);
      });
    });
    request.once("error", (error) => {
      client.close();
      reject(error);
    });
    request.end(JSON.stringify({
      aps: {
        alert: {
          title: body.alert?.title?.slice(0, 80) || "Zimlo",
          body: body.alert?.body?.slice(0, 180) || "有一项需要你处理",
        },
        sound: "default",
        "mutable-content": 1,
        "thread-id": body.collapseId?.split(":")[0] ?? "zimlo",
      },
      route: body.route,
      kind: body.kind,
    }));
  });
}

function validSignature(timestamp: string, rawBody: string, signature: string): boolean {
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time) || Math.abs(Date.now() - time) > 5 * 60 * 1_000) return false;
  try {
    return verify(null, Buffer.from(`${timestamp}.${rawBody}`), senderPublicKey, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

const app = Fastify({ logger: true });
app.get("/healthz", async () => ({ ok: true, service: "zimlo-push-relay", storesContent: false }));

app.post("/v1/devices", async (request, reply) => {
  if (request.headers.authorization !== `Bearer ${registrationSecret}`) return reply.code(401).send({ error: "unauthorized" });
  const body = request.body as RegisterBody;
  if (body.platform !== "ios" || !body.token || !/^[a-f0-9]{64,256}$/u.test(body.token) || !body.publicKey) {
    return reply.code(400).send({ error: "invalid_registration" });
  }
  const now = new Date().toISOString();
  const existing = database.prepare("SELECT endpoint, created_at FROM devices WHERE token = ?").get(body.token) as { endpoint: string; created_at: string } | undefined;
  const endpoint = existing?.endpoint ?? randomUUID();
  database.prepare(`
    INSERT INTO devices(endpoint, platform, token, public_key, active, created_at, updated_at)
    VALUES (?, 'ios', ?, ?, 1, ?, ?)
    ON CONFLICT(token) DO UPDATE SET public_key = excluded.public_key, active = 1, updated_at = excluded.updated_at
  `).run(endpoint, body.token, body.publicKey, existing?.created_at ?? now, now);
  return { endpoint };
});

app.post("/v1/send", { config: { rawBody: true } }, async (request, reply) => {
  const timestamp = String(request.headers["x-zimlo-timestamp"] ?? "");
  const signature = String(request.headers["x-zimlo-signature"] ?? "");
  const rawBody = JSON.stringify(request.body);
  if (!validSignature(timestamp, rawBody, signature)) return reply.code(401).send({ error: "invalid_signature" });
  const body = request.body as SendBody;
  if (!body.endpoint || !body.kind || !body.collapseId || !body.route?.ciphertext) return reply.code(400).send({ error: "invalid_request" });
  const device = database.prepare("SELECT token FROM devices WHERE endpoint = ? AND active = 1").get(body.endpoint) as { token: string } | undefined;
  if (!device) return reply.code(410).send({ error: "endpoint_inactive" });
  const status = await sendAPNs(device.token, body);
  if (status === 410) database.prepare("UPDATE devices SET active = 0, updated_at = ? WHERE endpoint = ?").run(new Date().toISOString(), body.endpoint);
  if (status < 200 || status >= 300) return reply.code(status === 410 ? 410 : 502).send({ error: "apns_rejected", status });
  return { ok: true };
});

const port = Number(process.env.PORT ?? 8080);
await app.listen({ host: "0.0.0.0", port });
