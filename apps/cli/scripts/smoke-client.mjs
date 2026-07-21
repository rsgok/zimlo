import WebSocket from "ws";
import {
  decryptFrame,
  deriveConnectionKeys,
  encryptFrame,
  fromBase64Url,
  makeProof,
  randomBytes,
  toBase64Url,
  verifyProof,
} from "@zimlo/protocol/crypto";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:4747";
const bootstrap = await fetch(`${baseUrl}/api/local-bootstrap`);
if (!bootstrap.ok) throw new Error(`Bootstrap failed: ${bootstrap.status}`);
const credentials = await bootstrap.json();
const clientNonce = randomBytes(24);
const clientNonceText = toBase64Url(clientNonce);
const deviceKey = fromBase64Url(credentials.deviceKey);
const aad = `zimlo-ws-v1:${credentials.deviceId}`;
const wsUrl = new URL("/ws", baseUrl);
wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
const socket = new WebSocket(wsUrl);

let clientTx;
let serverTx;
let receiveCounter = 0;
let sendCounter = 0;
let sessionCount = 0;
let selectedSession = null;
let pendingSessions = [];

function requestEvents(sessionId) {
  const command = { type: "session.events.request", sessionId };
  socket.send(JSON.stringify({
    type: "secure",
    counter: sendCounter,
    ciphertext: encryptFrame(clientTx, sendCounter, command, aad),
  }));
  sendCounter += 1;
}

const timeout = setTimeout(() => {
  socket.close();
  throw new Error("Smoke client timed out");
}, 10_000);

await new Promise((resolve, reject) => {
  socket.on("open", () => socket.send(JSON.stringify({
    type: "auth",
    deviceId: credentials.deviceId,
    clientNonce: clientNonceText,
    proof: makeProof(deviceKey, `ws:${clientNonceText}`),
  })));
  socket.on("message", (raw) => {
    try {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "auth.ok") {
        if (!verifyProof(deviceKey, `ws-server:${clientNonceText}:${frame.serverNonce}`, frame.proof)) {
          throw new Error("Invalid server proof");
        }
        const keys = deriveConnectionKeys(deviceKey, clientNonce, fromBase64Url(frame.serverNonce));
        clientTx = keys.clientTx;
        serverTx = keys.serverTx;
        return;
      }
      if (frame.type !== "secure" || frame.counter !== receiveCounter || !serverTx) throw new Error("Invalid secure frame");
      const message = decryptFrame(serverTx, frame.counter, frame.ciphertext, aad);
      receiveCounter += 1;
      if (message.type === "session.snapshot") {
        sessionCount = message.snapshot.sessions.length;
        pendingSessions = message.snapshot.sessions.map((session) => session.id);
        selectedSession = pendingSessions.shift() ?? null;
        if (!selectedSession) throw new Error("Discovery returned no sessions");
        requestEvents(selectedSession);
      }
      if (message.type === "session.events" && message.sessionId === selectedSession) {
        if (message.events.length === 0 && pendingSessions.length > 0) {
          selectedSession = pendingSessions.shift();
          requestEvents(selectedSession);
          return;
        }
        console.log(JSON.stringify({
          encryptedHandshake: true,
          sessionCount,
          selectedSession,
          eventCount: message.events.length,
        }));
        resolve();
      }
    } catch (error) {
      reject(error);
    }
  });
  socket.on("error", reject);
});

clearTimeout(timeout);
socket.close();
