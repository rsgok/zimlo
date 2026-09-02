import WebSocket from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";
import {
  createKeyPair,
  decryptFrame,
  deriveConnectionKeys,
  deriveDeviceKey,
  derivePairKey,
  encryptFrame,
  fromBase64Url,
  makeProof,
  randomBytes,
  toBase64Url,
  verifyProof,
} from "@zimlo/protocol/crypto";
import { proxyURLFor } from "../dist/proxy-environment.js";

const localURL = process.argv.find((value) => value.startsWith("http://") || value.startsWith("https://"))
  ?? "http://127.0.0.1:4747";

function webSocketURL(baseURL, pathname) {
  const url = new URL(pathname, baseURL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.search = "";
  url.hash = "";
  return url;
}

function webSocketOptions(url) {
  const proxyURL = proxyURLFor(url);
  return proxyURL ? { agent: new HttpsProxyAgent(proxyURL) } : {};
}

async function connectSecure({
  url,
  deviceId,
  deviceKey,
  protocols,
  onMessage,
  timeoutMs = 15_000,
}) {
  const socket = new WebSocket(url, protocols, webSocketOptions(url));
  const clientNonce = randomBytes(24);
  const clientNonceText = toBase64Url(clientNonce);
  const aad = `zimlo-ws-v1:${deviceId}`;
  let clientTx;
  let serverTx;
  let receiveCounter = 0;
  let sendCounter = 0;
  let snapshotCount = 0;
  let settled = false;

  const send = (command) => {
    if (!clientTx) throw new Error("Secure connection is not authenticated");
    const counter = sendCounter;
    sendCounter += 1;
    socket.send(JSON.stringify({
      type: "secure",
      counter,
      ciphertext: encryptFrame(clientTx, counter, command, aad),
    }));
  };

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`Secure connection timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, "Smoke complete");
      if (error) reject(error);
      else resolve(value);
    };

    socket.on("open", () => socket.send(JSON.stringify({
      type: "auth",
      deviceId,
      clientNonce: clientNonceText,
      proof: makeProof(deviceKey, `ws:${clientNonceText}`),
    })));
    socket.on("unexpected-response", (_request, response) => {
      finish(new Error(`WebSocket upgrade failed: ${response.statusCode}`));
    });
    socket.on("message", (raw) => {
      try {
        const frame = JSON.parse(raw.toString());
        if (frame.type === "auth.ok") {
          if (!verifyProof(deviceKey, `ws-server:${clientNonceText}:${frame.serverNonce}`, frame.proof)) {
            throw new Error("Invalid Bridge server proof");
          }
          const keys = deriveConnectionKeys(
            deviceKey,
            clientNonce,
            fromBase64Url(frame.serverNonce),
          );
          clientTx = keys.clientTx;
          serverTx = keys.serverTx;
          return;
        }
        if (frame.type !== "secure" || frame.counter !== receiveCounter || !serverTx) {
          throw new Error("Invalid secure frame");
        }
        const message = decryptFrame(serverTx, frame.counter, frame.ciphertext, aad);
        receiveCounter += 1;
        if (message.type === "error") throw new Error(`Bridge rejected smoke command: ${message.code}`);
        if (message.type === "session.snapshot") snapshotCount += 1;
        const result = onMessage({ message, snapshotCount, send });
        if (result !== undefined) finish(null, result);
      } catch (error) {
        finish(error);
      }
    });
    socket.on("error", (error) => finish(error));
  });
}

async function revokeSmokeDevice(deviceId) {
  const bootstrap = await fetch(`${localURL}/api/local-bootstrap`);
  if (!bootstrap.ok) throw new Error(`Local admin bootstrap failed: ${bootstrap.status}`);
  const credentials = await bootstrap.json();
  let remaining;
  await connectSecure({
    url: webSocketURL(localURL, "/ws"),
    deviceId: credentials.deviceId,
    deviceKey: fromBase64Url(credentials.deviceKey),
    onMessage: ({ message, snapshotCount, send }) => {
      if (message.type === "session.snapshot" && snapshotCount === 1) {
        send({ type: "devices.request" });
        return undefined;
      }
      if (message.type !== "devices.list") return undefined;
      if (!remaining) {
        remaining = message.devices
          .filter((device) => device.name === "Cloud pairing smoke" && !device.revokedAt)
          .map((device) => device.id);
        if (!remaining.includes(deviceId)) {
          throw new Error("New smoke device was not visible to the local administrator");
        }
      }
      const activeIds = new Set(
        message.devices.filter((device) => !device.revokedAt).map((device) => device.id),
      );
      remaining = remaining.filter((id) => activeIds.has(id));
      const next = remaining.shift();
      if (next) {
        send({ type: "device.revoke", deviceId: next });
        return undefined;
      }
      return true;
    },
  });
}

async function assertRemoteCredentialRevoked(cloud) {
  const url = webSocketURL(cloud.relayURL, "/v1/sync/device");
  const socket = new WebSocket(
    url,
    ["zimlo-relay-v1", `zimlo-token.${cloud.accessToken}`],
    webSocketOptions(url),
  );
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out while verifying cloud device revocation"));
    }, 10_000);
    socket.on("open", () => {
      clearTimeout(timeout);
      socket.close();
      reject(new Error("Revoked cloud credential still opened a relay connection"));
    });
    socket.on("unexpected-response", (_request, response) => {
      clearTimeout(timeout);
      response.resume();
      socket.terminate();
      if (response.statusCode === 401) resolve();
      else reject(new Error(`Revoked credential returned unexpected status ${response.statusCode}`));
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

let smokeDeviceId;
let completed;
let output;
try {
  const created = await fetch(`${localURL}/api/local/pairing`, { method: "POST" });
  if (!created.ok) throw new Error(`Local pairing creation failed: ${created.status} ${await created.text()}`);
  const pairing = await created.json();
  const pairURL = new URL(pairing.pairUrl);
  const values = new URLSearchParams(pairURL.hash.slice(1));
  const pairingId = values.get("pairingId");
  const pairingToken = values.get("pairingToken");
  const secretText = values.get("secret");
  const bridgeKey = values.get("bridgeKey");
  if (!pairingId || !pairingToken || !secretText || !bridgeKey) {
    throw new Error("Pairing URL is missing cloud handshake fields");
  }

  const secret = fromBase64Url(secretText);
  const client = createKeyPair();
  const pairKey = derivePairKey(
    client.privateKey,
    fromBase64Url(bridgeKey),
    secret,
  );
  const started = await fetch(new URL("/api/pair", pairURL), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pairingId,
      pairingToken,
      clientPublicKey: Buffer.from(client.publicKey).toString("base64url"),
      proof: makeProof(pairKey, `client:${pairingId}`),
      name: "Cloud pairing smoke",
    }),
  });
  if (started.status !== 202) throw new Error(`Cloud pairing did not queue: ${started.status} ${await started.text()}`);
  const pending = await started.json();

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const resultURL = new URL("/api/pair", pairURL);
    resultURL.search = new URLSearchParams({
      pairingId,
      pairingToken,
      requestId: pending.requestId,
    }).toString();
    const response = await fetch(resultURL);
    if (response.status === 202) continue;
    if (!response.ok) throw new Error(`Cloud pairing failed: ${response.status} ${await response.text()}`);
    completed = await response.json();
    break;
  }

  if (completed?.deviceId) smokeDeviceId = completed.deviceId;
  if (!smokeDeviceId || !completed?.cloud?.accessToken || !completed?.cloud?.relayURL) {
    throw new Error("Cloud pairing response did not provision device relay credentials");
  }
  if (!verifyProof(pairKey, `server:${completed.deviceId}`, completed.serverProof)) {
    throw new Error("Cloud pairing server proof is invalid");
  }

  const remoteResult = await connectSecure({
    url: webSocketURL(completed.cloud.relayURL, "/v1/sync/device"),
    protocols: ["zimlo-relay-v1", `zimlo-token.${completed.cloud.accessToken}`],
    deviceId: completed.deviceId,
    deviceKey: deriveDeviceKey(pairKey, secret),
    onMessage: ({ message, snapshotCount, send }) => {
      if (message.type !== "session.snapshot") return undefined;
      if (snapshotCount === 1) {
        send({ type: "snapshot.request", afterSequence: message.snapshot.sequence });
        return undefined;
      }
      return {
        sequence: message.snapshot.sequence,
        sessionCount: message.snapshot.sessions.length,
        projectCount: message.snapshot.projects.length,
      };
    },
  });

  output = {
    ok: true,
    encryptedRemoteSync: true,
    pairingHost: pairURL.host,
    relayURL: completed.cloud.relayURL,
    ...remoteResult,
  };
} finally {
  if (smokeDeviceId) {
    await revokeSmokeDevice(smokeDeviceId);
    if (completed?.cloud) await assertRemoteCredentialRevoked(completed.cloud);
  }
}
console.log(JSON.stringify({ ...output, revokedCleanup: true }));
