import {
  createAPNsJWT,
  freshTimestamp,
  installationRegistrationMessage,
  sha256Bytes,
  sha256Text,
  signedRequestMessage,
  verifyInstallationSignature,
} from "./crypto.js";
import {
  apnsConfigurationStatus,
  apnsCredentialsFor,
  type APNsCredentials,
  type APNsEnvironment,
  type APNsSecretBindings,
} from "./apns-config.js";
import { validPairingId } from "./identifiers.js";
import { PairingRoom } from "./pairing-room.js";
import { latestMacReleaseName, releaseAssetHeaders, releaseAssetKey } from "./release-assets.js";
import { RelayRoom } from "./relay-room.js";
import { ZIMLO_PROTOCOL_VERSION } from "./contract.generated.js";

interface Env extends APNsSecretBindings {
  DB: D1Database;
  RELAY_ROOMS: DurableObjectNamespace;
  PAIRING_ROOMS: DurableObjectNamespace;
  RELEASES?: R2Bucket;
  MATERIALS?: R2Bucket;
  REGISTRATION_RATE_LIMITER: RateLimit;
  AUTH_RATE_LIMITER: RateLimit;
}

interface InstallationRow {
  id: string;
  public_key_spki: string;
  disabled_at: string | null;
}

interface DeviceRow {
  installation_id: string;
  device_id: string;
  apns_token: string | null;
  apns_environment: "development" | "production";
  route_public_key: string | null;
}

interface PushBody {
  deviceId?: string;
  kind?: "approval" | "approval_reminder" | "result" | "failure";
  collapseId?: string;
  badge?: number;
  alert?: { title?: string; body?: string };
  route?: { ephemeralPublicKey?: string; nonce?: string; ciphertext?: string };
  // Plaintext UNNotificationCategory identifier (generic, no task content);
  // forwarded to `aps.category` so the lock screen can render quick actions.
  category?: string;
}

interface PairingRegistrationBody {
  pairingId?: string;
  tokenHash?: string;
  expiresAt?: string;
}

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

async function releaseAsset(request: Request, env: Env, pathname: string): Promise<Response> {
  const key = releaseAssetKey(pathname);
  if (!key) return jsonError(404, "release_not_found");
  if (!env.RELEASES) return jsonError(503, "release_storage_unavailable");
  const name = key.slice("macos/".length);
  if (request.method === "HEAD") {
    const object = await env.RELEASES.head(key);
    if (!object) return jsonError(404, "release_not_found");
    const headers = new Headers(releaseAssetHeaders(name));
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("x-content-type-options", "nosniff");
    return new Response(null, { headers });
  }
  const object = await env.RELEASES.get(key);
  if (!object) return jsonError(404, "release_not_found");
  const headers = new Headers(releaseAssetHeaders(name));
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("x-content-type-options", "nosniff");
  return new Response(object.body, { headers });
}

async function latestMacRelease(request: Request, env: Env): Promise<Response> {
  if (!env.RELEASES) return jsonError(503, "release_storage_unavailable");
  const manifest = await env.RELEASES.get("macos/latest.json");
  if (!manifest) return jsonError(404, "release_not_found");
  let value: unknown;
  try {
    value = await manifest.json();
  } catch {
    return jsonError(503, "release_manifest_invalid");
  }
  const fileName = latestMacReleaseName(value);
  if (!fileName) return jsonError(503, "release_manifest_invalid");
  const target = new URL(request.url);
  target.pathname = `/releases/macos/${encodeURIComponent(fileName)}`;
  target.search = "";
  return Response.redirect(target.toString(), 302);
}

function validId(value: unknown, prefix: string): value is string {
  return typeof value === "string" && value.startsWith(prefix) && /^[a-zA-Z0-9:_-]{12,160}$/u.test(value);
}

function actorKey(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

async function deviceForBearer(request: Request, env: Env): Promise<{ installationId: string; deviceId: string } | Response> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return jsonError(401, "device_token_required");
  const tokenHash = await sha256Text(authorization.slice(7));
  const row = await env.DB.prepare(`
    SELECT installation_id, device_id FROM devices
    WHERE access_token_hash = ? AND active = 1
  `).bind(tokenHash).first<{ installation_id: string; device_id: string }>();
  return row ? { installationId: row.installation_id, deviceId: row.device_id } : jsonError(401, "device_inactive");
}

function materialId(value: string): boolean {
  return /^material_[a-zA-Z0-9_-]{12,140}$/u.test(value);
}

function materialUploadKey(installationId: string, deviceId: string, id: string): string {
  return `uploads/${installationId}/${deviceId}/${id}`;
}

function materialDownloadKey(installationId: string, deviceId: string, id: string): string {
  return `downloads/${installationId}/${deviceId}/${id}`;
}

async function uploadMaterial(request: Request, env: Env, id: string): Promise<Response> {
  if (!env.MATERIALS) return jsonError(503, "material_storage_unavailable");
  if (!materialId(id)) return jsonError(400, "material_id_invalid");
  const device = await deviceForBearer(request, env);
  if (device instanceof Response) return device;
  const length = Number(request.headers.get("content-length") ?? 0);
  if (!Number.isSafeInteger(length) || length < 29 || length > 50 * 1024 * 1024 + 28) {
    return jsonError(413, "material_too_large");
  }
  if (!request.body) return jsonError(400, "material_body_required");
  await env.MATERIALS.put(materialUploadKey(device.installationId, device.deviceId, id), request.body, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { createdAt: new Date().toISOString() },
  });
  return Response.json({ ok: true, materialId: id }, { status: 201 });
}

async function installationMaterial(
  request: Request,
  env: Env,
  deviceId: string,
  id: string,
): Promise<Response> {
  if (!env.MATERIALS) return jsonError(503, "material_storage_unavailable");
  if (!materialId(id)) return jsonError(400, "material_id_invalid");
  const installation = await installationForSignedRequest(request, env);
  if (installation instanceof Response) return installation;
  const device = await env.DB.prepare(`
    SELECT 1 AS found FROM devices WHERE installation_id = ? AND device_id = ?
  `).bind(installation.id, deviceId).first<{ found: number }>();
  if (!device) return jsonError(404, "material_not_found");
  const key = request.method === "PUT"
    ? materialDownloadKey(installation.id, deviceId, id)
    : materialUploadKey(installation.id, deviceId, id);
  if (request.method === "PUT") {
    const length = Number(request.headers.get("content-length") ?? 0);
    if (!Number.isSafeInteger(length) || length < 29 || length > 50 * 1024 * 1024 + 28) {
      return jsonError(413, "material_too_large");
    }
    const declaredHash = request.headers.get("x-zimlo-content-sha256") ?? "";
    if (!/^[a-zA-Z0-9_-]{43}$/u.test(declaredHash)) return jsonError(400, "material_hash_required");
    const data = await request.arrayBuffer();
    if (await sha256Bytes(data) !== declaredHash) return jsonError(400, "material_hash_mismatch");
    await env.MATERIALS.put(key, data, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: { createdAt: new Date().toISOString() },
    });
    return Response.json({ ok: true, materialId: id }, { status: 201 });
  }
  if (request.method === "DELETE") {
    await env.MATERIALS.delete(key);
    return Response.json({ ok: true });
  }
  const object = await env.MATERIALS.get(key);
  if (!object) return jsonError(404, "material_not_found");
  return new Response(object.body, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(object.size),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function deviceMaterial(request: Request, env: Env, id: string): Promise<Response> {
  if (!env.MATERIALS) return jsonError(503, "material_storage_unavailable");
  if (!materialId(id)) return jsonError(400, "material_id_invalid");
  const device = await deviceForBearer(request, env);
  if (device instanceof Response) return device;
  const key = materialDownloadKey(device.installationId, device.deviceId, id);
  if (request.method === "DELETE") {
    await env.MATERIALS.delete(key);
    return Response.json({ ok: true });
  }
  const object = await env.MATERIALS.get(key);
  if (!object) return jsonError(404, "material_not_found");
  return new Response(object.body, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(object.size),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function installationForSignedRequest(
  request: Request,
  env: Env,
  rawBody = "",
): Promise<InstallationRow | Response> {
  const installationId = request.headers.get("x-zimlo-installation") ?? "";
  const timestamp = request.headers.get("x-zimlo-timestamp") ?? "";
  const signature = request.headers.get("x-zimlo-signature") ?? "";
  if (!validId(installationId, "installation_") || !freshTimestamp(timestamp) || !signature) {
    return jsonError(401, "invalid_signature");
  }
  const row = await env.DB.prepare(
    "SELECT id, public_key_spki, disabled_at FROM installations WHERE id = ?",
  ).bind(installationId).first<InstallationRow>();
  if (!row || row.disabled_at) return jsonError(401, "installation_inactive");
  const declaredBodyHash = request.headers.get("x-zimlo-content-sha256");
  const message = declaredBodyHash
    ? `${timestamp}.${request.method.toUpperCase()}.${new URL(request.url).pathname}.${declaredBodyHash}`
    : await signedRequestMessage(timestamp, request.method, new URL(request.url).pathname, rawBody);
  if (!await verifyInstallationSignature(row.public_key_spki, message, signature)) {
    return jsonError(401, "invalid_signature");
  }
  await env.DB.prepare("UPDATE installations SET last_seen_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), installationId).run();
  return row;
}

async function registerInstallation(request: Request, env: Env): Promise<Response> {
  const body = await request.json<Record<string, unknown>>().catch(() => null);
  const installationId = body?.installationId;
  const publicKey = body?.publicKey;
  const timestamp = body?.timestamp;
  const signature = body?.signature;
  if (
    !validId(installationId, "installation_")
    || typeof publicKey !== "string"
    || publicKey.length > 512
    || typeof timestamp !== "string"
    || typeof signature !== "string"
    || !freshTimestamp(timestamp)
  ) {
    return jsonError(400, "invalid_installation");
  }
  if (!await verifyInstallationSignature(
    publicKey,
    installationRegistrationMessage(timestamp, installationId, publicKey),
    signature,
  )) {
    return jsonError(401, "invalid_signature");
  }
  const existing = await env.DB.prepare("SELECT public_key_spki FROM installations WHERE id = ?")
    .bind(installationId).first<{ public_key_spki: string }>();
  if (existing && existing.public_key_spki !== publicKey) return jsonError(409, "installation_exists");
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO installations(id, public_key_spki, created_at, last_seen_at, disabled_at)
    VALUES (?, ?, ?, ?, NULL)
    ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at
  `).bind(installationId, publicKey, now, now).run();
  return Response.json({ installationId });
}

async function upsertDevice(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  const installation = await installationForSignedRequest(request, env, rawBody);
  if (installation instanceof Response) return installation;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return jsonError(400, "invalid_json");
  }
  const deviceId = body.deviceId;
  const accessTokenHash = body.accessTokenHash;
  const apnsToken = body.apnsToken;
  const apnsEnvironment = body.apnsEnvironment ?? "production";
  const routePublicKey = body.routePublicKey;
  if (
    !validId(deviceId, "device_")
    || typeof accessTokenHash !== "string"
    || accessTokenHash.length < 32
    || (apnsToken !== undefined && (typeof apnsToken !== "string" || !/^[a-f0-9]{64,256}$/u.test(apnsToken)))
    || (apnsEnvironment !== "development" && apnsEnvironment !== "production")
    || (routePublicKey !== undefined && (typeof routePublicKey !== "string" || routePublicKey.length > 256))
  ) {
    return jsonError(400, "invalid_device");
  }
  if (apnsToken !== undefined && !apnsCredentialsFor(env, apnsEnvironment)) {
    return jsonError(503, "apns_not_configured");
  }
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO devices(
      installation_id, device_id, access_token_hash, apns_token,
      apns_environment, route_public_key, active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(installation_id, device_id) DO UPDATE SET
      access_token_hash = excluded.access_token_hash,
      apns_token = COALESCE(excluded.apns_token, devices.apns_token),
      apns_environment = excluded.apns_environment,
      route_public_key = COALESCE(excluded.route_public_key, devices.route_public_key),
      active = 1,
      updated_at = excluded.updated_at
  `).bind(
    installation.id,
    deviceId,
    accessTokenHash,
    apnsToken ?? null,
    apnsEnvironment,
    routePublicKey ?? null,
    now,
    now,
  ).run();
  return Response.json({ endpoint: deviceId });
}

async function unregisterDevice(request: Request, env: Env, deviceId: string): Promise<Response> {
  const rawBody = await request.text();
  const installation = await installationForSignedRequest(request, env, rawBody);
  if (installation instanceof Response) return installation;
  if (!validId(deviceId, "device_")) return jsonError(400, "invalid_device");
  await env.DB.prepare(`
    UPDATE devices SET active = 0, updated_at = ?
    WHERE installation_id = ? AND device_id = ?
  `).bind(new Date().toISOString(), installation.id, deviceId).run();
  return Response.json({ ok: true });
}

async function unregisterPushDevice(request: Request, env: Env, deviceId: string): Promise<Response> {
  const rawBody = await request.text();
  const installation = await installationForSignedRequest(request, env, rawBody);
  if (installation instanceof Response) return installation;
  if (!validId(deviceId, "device_")) return jsonError(400, "invalid_device");
  await env.DB.prepare(`
    UPDATE devices SET apns_token = NULL, route_public_key = NULL, updated_at = ?
    WHERE installation_id = ? AND device_id = ?
  `).bind(new Date().toISOString(), installation.id, deviceId).run();
  return Response.json({ ok: true });
}

const cachedAPNsJWT = new Map<APNsEnvironment, { keyId: string; value: string; expiresAt: number }>();

async function apnsJWT(credentials: APNsCredentials, environment: APNsEnvironment): Promise<string> {
  const cached = cachedAPNsJWT.get(environment);
  if (cached && cached.keyId === credentials.keyId && cached.expiresAt > Date.now()) return cached.value;
  const value = await createAPNsJWT({
    privateKeyPEM: credentials.privateKeyPEM,
    keyId: credentials.keyId,
    teamId: credentials.teamId,
  });
  cachedAPNsJWT.set(environment, {
    keyId: credentials.keyId,
    value,
    expiresAt: Date.now() + 50 * 60 * 1_000,
  });
  return value;
}

async function sendPush(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  const installation = await installationForSignedRequest(request, env, rawBody);
  if (installation instanceof Response) return installation;
  let body: PushBody;
  try {
    body = JSON.parse(rawBody) as PushBody;
  } catch {
    return jsonError(400, "invalid_json");
  }
  if (
    !validId(body.deviceId, "device_")
    || !body.kind
    || !["approval", "approval_reminder", "result", "failure"].includes(body.kind)
    || !body.collapseId
    || !body.route?.ciphertext
    || !Number.isInteger(body.badge)
    || Number(body.badge) < 0
    || Number(body.badge) > 99
  ) {
    return jsonError(400, "invalid_push");
  }
  const device = await env.DB.prepare(`
    SELECT installation_id, device_id, apns_token, apns_environment, route_public_key
    FROM devices WHERE installation_id = ? AND device_id = ? AND active = 1
  `).bind(installation.id, body.deviceId).first<DeviceRow>();
  if (!device?.apns_token) return jsonError(410, "device_inactive");
  const credentials = apnsCredentialsFor(env, device.apns_environment);
  if (!credentials) return jsonError(503, "apns_not_configured");
  const origin = device.apns_environment === "production"
    ? "https://api.push.apple.com"
    : "https://api.sandbox.push.apple.com";
  const response = await fetch(`${origin}/3/device/${device.apns_token}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${await apnsJWT(credentials, device.apns_environment)}`,
      "content-type": "application/json",
      "apns-topic": credentials.topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-collapse-id": body.collapseId.slice(0, 64),
    },
    body: JSON.stringify({
      aps: {
        alert: {
          title: body.alert?.title?.slice(0, 80) || "Zimlo",
          body: body.alert?.body?.slice(0, 180) || "有一项需要你处理",
        },
        sound: "default",
        badge: body.badge,
        "mutable-content": 1,
        "thread-id": body.collapseId.split(":")[0] || "zimlo",
        ...(body.category ? { category: body.category.slice(0, 64) } : {}),
      },
      route: body.route,
      kind: body.kind,
    }),
  });
  if (response.status === 410) {
    await env.DB.prepare(`
      UPDATE devices SET active = 0, updated_at = ?
      WHERE installation_id = ? AND device_id = ?
    `).bind(new Date().toISOString(), installation.id, body.deviceId).run();
  }
  await env.DB.prepare(`
    INSERT INTO push_audit(id, installation_id, device_id, kind, collapse_id, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(),
    installation.id,
    body.deviceId,
    body.kind,
    body.collapseId,
    response.status,
    new Date().toISOString(),
  ).run();
  if (!response.ok) {
    return Response.json(
      { error: "apns_rejected", apnsStatus: response.status },
      { status: response.status === 410 ? 410 : 502 },
    );
  }
  return Response.json({ ok: true, apnsStatus: response.status });
}

async function relayWebSocket(request: Request, env: Env, role: "mac" | "device"): Promise<Response> {
  let installationId: string;
  let deviceId = "";
  if (role === "mac") {
    const installation = await installationForSignedRequest(request, env);
    if (installation instanceof Response) return installation;
    installationId = installation.id;
  } else {
    const authorization = request.headers.get("authorization") ?? "";
    const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((value) => value.trim());
    const protocolToken = protocols.find((value) => value.startsWith("zimlo-token."))?.slice("zimlo-token.".length);
    const accessToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : protocolToken;
    if (!accessToken) return jsonError(401, "device_token_required");
    const tokenHash = await sha256Text(accessToken);
    const device = await env.DB.prepare(`
      SELECT installation_id, device_id FROM devices
      WHERE access_token_hash = ? AND active = 1
    `).bind(tokenHash).first<{ installation_id: string; device_id: string }>();
    if (!device) return jsonError(401, "device_inactive");
    installationId = device.installation_id;
    deviceId = device.device_id;
  }
  const headers = new Headers(request.headers);
  headers.set("x-zimlo-relay-role", role);
  if (deviceId) headers.set("x-zimlo-device-id", deviceId);
  headers.delete("authorization");
  headers.delete("x-zimlo-signature");
  headers.delete("sec-websocket-protocol");
  if ((request.headers.get("sec-websocket-protocol") ?? "").includes("zimlo-relay-v1")) {
    headers.set("x-zimlo-websocket-protocol", "zimlo-relay-v1");
  }
  const room = env.RELAY_ROOMS.get(env.RELAY_ROOMS.idFromName(installationId));
  return room.fetch(new Request(request, { headers }));
}

function pairingRoom(env: Env, pairingId: string): DurableObjectStub {
  return env.PAIRING_ROOMS.get(env.PAIRING_ROOMS.idFromName(pairingId));
}

async function registerPairing(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  const installation = await installationForSignedRequest(request, env, rawBody);
  if (installation instanceof Response) return installation;
  let body: PairingRegistrationBody;
  try {
    body = JSON.parse(rawBody) as PairingRegistrationBody;
  } catch {
    return jsonError(400, "invalid_json");
  }
  if (
    !validPairingId(body.pairingId)
    || typeof body.tokenHash !== "string"
    || body.tokenHash.length < 32
    || typeof body.expiresAt !== "string"
    || new Date(body.expiresAt).getTime() <= Date.now()
    || new Date(body.expiresAt).getTime() > Date.now() + 5 * 60 * 1_000
  ) {
    return jsonError(400, "invalid_pairing");
  }
  return pairingRoom(env, body.pairingId).fetch("https://pairing.internal/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      installationId: installation.id,
      tokenHash: body.tokenHash,
      expiresAt: body.expiresAt,
    }),
  });
}

async function pendingPairingRequest(
  request: Request,
  env: Env,
  pairingId: string,
): Promise<Response> {
  const installation = await installationForSignedRequest(request, env);
  if (installation instanceof Response) return installation;
  return pairingRoom(env, pairingId).fetch("https://pairing.internal/mac/request", {
    headers: { "x-zimlo-installation-id": installation.id },
  });
}

async function completePairing(
  request: Request,
  env: Env,
  pairingId: string,
): Promise<Response> {
  const rawBody = await request.text();
  const installation = await installationForSignedRequest(request, env, rawBody);
  if (installation instanceof Response) return installation;
  return pairingRoom(env, pairingId).fetch("https://pairing.internal/mac/complete", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-zimlo-installation-id": installation.id,
    },
    body: rawBody,
  });
}

async function cancelPairing(
  request: Request,
  env: Env,
  pairingId: string,
): Promise<Response> {
  const installation = await installationForSignedRequest(request, env);
  if (installation instanceof Response) return installation;
  return pairingRoom(env, pairingId).fetch("https://pairing.internal/mac", {
    method: "DELETE",
    headers: { "x-zimlo-installation-id": installation.id },
  });
}

async function beginDevicePairing(request: Request, env: Env): Promise<Response> {
  const body = await request.json<Record<string, unknown>>().catch(() => null);
  const pairingId = body?.pairingId;
  if (
    !validPairingId(pairingId)
    || typeof body?.pairingToken !== "string"
    || typeof body?.clientPublicKey !== "string"
    || typeof body?.proof !== "string"
  ) {
    return jsonError(400, "invalid_pairing");
  }
  return pairingRoom(env, pairingId).fetch("https://pairing.internal/device", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function devicePairingResult(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const pairingId = url.searchParams.get("pairingId") ?? "";
  if (!validPairingId(pairingId)) return jsonError(400, "invalid_pairing");
  const internal = new URL("https://pairing.internal/device/result");
  for (const key of ["pairingToken", "requestId"]) {
    const value = url.searchParams.get(key);
    if (value) internal.searchParams.set(key, value);
  }
  return pairingRoom(env, pairingId).fetch(internal);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const browserCrossOrigin = url.pathname === "/api/pair" || /^\/v1\/materials\/[^/]+$/u.test(url.pathname);
    if (request.method === "OPTIONS" && browserCrossOrigin) {
      return new Response(null, { status: 204, headers: browserCORSHeaders() });
    }
    if (request.method === "GET" && url.pathname === "/healthz") {
      const push = apnsConfigurationStatus(env);
      return Response.json({
        ok: true,
        service: "zimlo-cloud",
        protocolVersion: ZIMLO_PROTOCOL_VERSION,
        storesContent: false,
        storesEncryptedMaterials: Boolean(env.MATERIALS),
        encryptedRemoteSync: true,
        pushConfigured: push.configured,
        pushEnvironments: {
          sandbox: push.development,
          production: push.production,
        },
      });
    }
    if (
      (request.method === "GET" || request.method === "HEAD")
      && url.pathname === "/releases/macos/download"
    ) {
      return latestMacRelease(request, env);
    }
    if (
      (request.method === "GET" || request.method === "HEAD")
      && url.pathname.startsWith("/releases/macos/")
    ) {
      return releaseAsset(request, env, url.pathname);
    }
    if (request.method === "POST" && url.pathname === "/v1/installations") {
      const allowed = await env.REGISTRATION_RATE_LIMITER.limit({ key: actorKey(request) });
      if (!allowed.success) return jsonError(429, "registration_rate_limited");
      return registerInstallation(request, env);
    }
    if (request.method === "POST" && url.pathname === "/v1/devices") {
      return upsertDevice(request, env);
    }
    if (request.method === "POST" && url.pathname === "/v1/pairings") {
      return registerPairing(request, env);
    }
    if (request.method === "GET" && /^\/v1\/pairings\/[^/]+\/request$/u.test(url.pathname)) {
      const pairingId = decodeURIComponent(
        url.pathname.slice("/v1/pairings/".length, -"/request".length),
      );
      return pendingPairingRequest(request, env, pairingId);
    }
    if (request.method === "POST" && /^\/v1\/pairings\/[^/]+\/complete$/u.test(url.pathname)) {
      const pairingId = decodeURIComponent(
        url.pathname.slice("/v1/pairings/".length, -"/complete".length),
      );
      return completePairing(request, env, pairingId);
    }
    if (request.method === "DELETE" && /^\/v1\/pairings\/[^/]+$/u.test(url.pathname)) {
      const pairingId = decodeURIComponent(url.pathname.slice("/v1/pairings/".length));
      return cancelPairing(request, env, pairingId);
    }
    if (request.method === "POST" && url.pathname === "/api/pair") {
      const allowed = await env.AUTH_RATE_LIMITER.limit({ key: `pair:${actorKey(request)}` });
      if (!allowed.success) return jsonError(429, "pairing_rate_limited");
      return withBrowserCORS(await beginDevicePairing(request, env));
    }
    if (request.method === "GET" && url.pathname === "/api/pair") {
      const allowed = await env.AUTH_RATE_LIMITER.limit({ key: `pair:${actorKey(request)}` });
      if (!allowed.success) return jsonError(429, "pairing_rate_limited");
      return withBrowserCORS(await devicePairingResult(request, env));
    }
    if (request.method === "DELETE" && /^\/v1\/devices\/[^/]+\/push$/u.test(url.pathname)) {
      const encodedDeviceId = url.pathname.slice("/v1/devices/".length, -"/push".length);
      return unregisterPushDevice(request, env, decodeURIComponent(encodedDeviceId));
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/v1/devices/")) {
      return unregisterDevice(request, env, decodeURIComponent(url.pathname.slice("/v1/devices/".length)));
    }
    if (request.method === "POST" && url.pathname === "/v1/push") {
      return sendPush(request, env);
    }
    if (request.method === "PUT" && /^\/v1\/materials\/[^/]+$/u.test(url.pathname)) {
      const allowed = await env.AUTH_RATE_LIMITER.limit({ key: `material:${actorKey(request)}` });
      if (!allowed.success) return jsonError(429, "material_rate_limited");
      return uploadMaterial(request, env, decodeURIComponent(url.pathname.slice("/v1/materials/".length)));
    }
    if ((request.method === "GET" || request.method === "DELETE") && /^\/v1\/materials\/[^/]+$/u.test(url.pathname)) {
      return withBrowserCORS(await deviceMaterial(request, env, decodeURIComponent(url.pathname.slice("/v1/materials/".length))));
    }
    if ((request.method === "GET" || request.method === "DELETE" || request.method === "PUT") && /^\/v1\/materials\/[^/]+\/[^/]+$/u.test(url.pathname)) {
      const [, , , encodedDeviceId, encodedMaterialId] = url.pathname.split("/");
      return installationMaterial(request, env, decodeURIComponent(encodedDeviceId ?? ""), decodeURIComponent(encodedMaterialId ?? ""));
    }
    if (request.method === "GET" && url.pathname === "/v1/sync/mac") {
      const allowed = await env.AUTH_RATE_LIMITER.limit({ key: `mac:${actorKey(request)}` });
      if (!allowed.success) return jsonError(429, "relay_rate_limited");
      return relayWebSocket(request, env, "mac");
    }
    if (request.method === "GET" && url.pathname === "/v1/sync/device") {
      const allowed = await env.AUTH_RATE_LIMITER.limit({ key: `device:${actorKey(request)}` });
      if (!allowed.success) return jsonError(429, "relay_rate_limited");
      return relayWebSocket(request, env, "device");
    }
    return jsonError(404, "not_found");
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const cutoff = new Date(Date.now() - 45 * 24 * 60 * 60 * 1_000).toISOString();
    await env.DB.prepare("DELETE FROM push_audit WHERE created_at < ?").bind(cutoff).run();
  },
};

function browserCORSHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "86400",
  };
}

function withBrowserCORS(response: Response): Response {
  const next = new Response(response.body, response);
  for (const [key, value] of Object.entries(browserCORSHeaders())) next.headers.set(key, value);
  return next;
}

export { PairingRoom, RelayRoom };
