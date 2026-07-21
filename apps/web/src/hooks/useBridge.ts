import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientCommand, ServerMessage, Snapshot, UnifiedEvent } from "@zimlo/protocol";
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
import {
  clearCredentials,
  readCredentials,
  saveCredentials,
  type DeviceCredentials,
} from "../lib/credentials";

const EMPTY_SNAPSHOT: Snapshot = {
  sessions: [],
  cards: [],
  posts: [],
  tasks: [],
  actions: [],
  sequence: 0,
  lanApprovalsEnabled: false,
};

export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
  isLocalAdmin: boolean;
}

export interface PairingInfo {
  pairUrl: string;
  qrDataUrl: string;
  expiresAt: string;
}

export interface CodexPluginInfo {
  installed: boolean;
  detail: string;
  pluginPath: string;
  deepLink: string;
}

interface BridgeState {
  snapshot: Snapshot;
  events: Record<string, UnifiedEvent[]>;
  devices: DeviceInfo[];
  pairing: PairingInfo | null;
  codexPlugin: CodexPluginInfo | null;
  connected: boolean;
  pairingRequired: boolean;
  localAdmin: boolean;
  error: string | null;
  notice: string | null;
}

function isLocalHost(): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(window.location.hostname);
}

async function pairFromFragment(): Promise<DeviceCredentials | null> {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const pairingId = params.get("pairingId");
  const secretText = params.get("secret");
  const bridgeKeyText = params.get("bridgeKey");
  if (!pairingId || !secretText || !bridgeKeyText) return null;
  const secret = fromBase64Url(secretText);
  const pair = createKeyPair();
  const pairKey = derivePairKey(pair.privateKey, fromBase64Url(bridgeKeyText), secret);
  const response = await fetch("/api/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pairingId,
      clientPublicKey: toBase64Url(pair.publicKey),
      proof: makeProof(pairKey, `client:${pairingId}`),
      name: `${navigator.platform || "Mobile"} browser`,
    }),
  });
  if (!response.ok) throw new Error("配对链接已过期、已使用或校验失败。请在 Mac 上重新生成。");
  const result = await response.json() as { deviceId: string; serverProof: string };
  if (!verifyProof(pairKey, `server:${result.deviceId}`, result.serverProof)) throw new Error("Bridge 配对证明无效。");
  const credentials = { deviceId: result.deviceId, deviceKey: toBase64Url(deriveDeviceKey(pairKey, secret)) };
  await saveCredentials(credentials);
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  return credentials;
}

async function loadCredentials(): Promise<{ credentials: DeviceCredentials | null; localAdmin: boolean }> {
  const paired = await pairFromFragment();
  if (paired) return { credentials: paired, localAdmin: false };
  const existing = await readCredentials();
  if (existing) return { credentials: existing, localAdmin: isLocalHost() && existing.deviceId.startsWith("local_") };
  if (!isLocalHost()) return { credentials: null, localAdmin: false };
  const response = await fetch("/api/local-bootstrap");
  if (!response.ok) throw new Error("无法建立本机管理身份。");
  const credentials = await response.json() as DeviceCredentials;
  await saveCredentials(credentials);
  return { credentials, localAdmin: true };
}

function upsertById<T extends { id: string }>(values: T[], value: T): T[] {
  const index = values.findIndex((candidate) => candidate.id === value.id);
  if (index < 0) return [value, ...values];
  const next = [...values];
  next[index] = value;
  return next;
}

export function useBridge() {
  const [state, setState] = useState<BridgeState>({
    snapshot: EMPTY_SNAPSHOT,
    events: {},
    devices: [],
    pairing: null,
    codexPlugin: null,
    connected: false,
    pairingRequired: false,
    localAdmin: false,
    error: null,
    notice: null,
  });
  const sendRef = useRef<(command: ClientCommand) => void>(() => undefined);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;

    const applyMessage = (message: ServerMessage) => {
      setState((current) => {
        switch (message.type) {
          case "session.snapshot":
            return { ...current, snapshot: message.snapshot, error: null };
          case "session.updated":
            return { ...current, snapshot: { ...current.snapshot, sessions: upsertById(current.snapshot.sessions, message.session) } };
          case "session.removed":
            return {
              ...current,
              snapshot: {
                ...current.snapshot,
                sessions: current.snapshot.sessions.filter((session) => session.id !== message.sessionId),
                cards: current.snapshot.cards.filter((card) => card.sessionId !== message.sessionId),
                posts: current.snapshot.posts.filter((post) => post.sessionId !== message.sessionId),
                actions: current.snapshot.actions.filter((action) => action.sessionId !== message.sessionId),
              },
            };
          case "card.upsert":
            return { ...current, snapshot: { ...current.snapshot, cards: upsertById(current.snapshot.cards, message.card) } };
          case "feed.posted":
            return { ...current, snapshot: { ...current.snapshot, posts: upsertById(current.snapshot.posts, message.post) } };
          case "task.updated":
            return { ...current, snapshot: { ...current.snapshot, tasks: upsertById(current.snapshot.tasks, message.task) } };
          case "action.upsert": {
            const actions = message.action.state === "pending"
              ? upsertById(current.snapshot.actions.map((action) => ({ ...action, id: action.actionId })), { ...message.action, id: message.action.actionId }).map(({ id: _id, ...action }) => action)
              : current.snapshot.actions.filter((action) => action.actionId !== message.action.actionId);
            return { ...current, snapshot: { ...current.snapshot, actions } };
          }
          case "event.upsert": {
            if (!current.events[message.event.sessionId]) return current;
            return { ...current, events: { ...current.events, [message.event.sessionId]: [...current.events[message.event.sessionId]!, message.event] } };
          }
          case "session.events":
            return { ...current, events: { ...current.events, [message.sessionId]: message.events } };
          case "devices.list":
            return { ...current, devices: message.devices };
          case "pairing.created":
            return { ...current, pairing: message };
          case "lan.approvals.changed":
            return { ...current, snapshot: { ...current.snapshot, lanApprovalsEnabled: message.enabled } };
          case "codex.plugin.status":
            return { ...current, codexPlugin: message, notice: message.detail };
          case "capabilities.changed":
            return { ...current, snapshot: { ...current.snapshot, sessions: current.snapshot.sessions.map((session) => session.id === message.sessionId ? { ...session, capabilities: message.capabilities } : session) } };
          case "action.result":
          case "session.message.result":
            return { ...current, notice: message.message };
          case "error":
            return { ...current, error: message.message };
        }
      });
    };

    const connect = (credentials: DeviceCredentials) => {
      if (disposed) return;
      const url = new URL("/ws", window.location.href);
      url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(url);
      let clientTx: Uint8Array | null = null;
      let serverTx: Uint8Array | null = null;
      let sendCounter = 0;
      let receiveCounter = 0;
      const clientNonce = randomBytes(24);
      const clientNonceText = toBase64Url(clientNonce);
      const deviceKey = fromBase64Url(credentials.deviceKey);
      const aad = `zimlo-ws-v1:${credentials.deviceId}`;

      sendRef.current = (command) => {
        if (!socket || socket.readyState !== WebSocket.OPEN || !clientTx) {
          setState((current) => ({ ...current, notice: "Bridge 尚未连接，请稍后重试。" }));
          return;
        }
        const counter = sendCounter;
        sendCounter += 1;
        socket.send(JSON.stringify({ type: "secure", counter, ciphertext: encryptFrame(clientTx, counter, command, aad) }));
      };
      socket.onopen = () => socket?.send(JSON.stringify({
        type: "auth",
        deviceId: credentials.deviceId,
        clientNonce: clientNonceText,
        proof: makeProof(deviceKey, `ws:${clientNonceText}`),
      }));
      socket.onmessage = (event) => {
        try {
          const value = JSON.parse(String(event.data)) as Record<string, unknown>;
          if (value.type === "auth.ok" && typeof value.serverNonce === "string" && typeof value.proof === "string") {
            if (!verifyProof(deviceKey, `ws-server:${clientNonceText}:${value.serverNonce}`, value.proof)) throw new Error("Bridge 身份校验失败。");
            const keys = deriveConnectionKeys(deviceKey, clientNonce, fromBase64Url(value.serverNonce));
            clientTx = keys.clientTx;
            serverTx = keys.serverTx;
            setState((current) => ({ ...current, connected: true, error: null }));
            return;
          }
          if (value.type !== "secure" || typeof value.counter !== "number" || typeof value.ciphertext !== "string" || !serverTx) return;
          if (value.counter !== receiveCounter) throw new Error("检测到消息重放或丢帧，连接已中止。");
          const message = decryptFrame<ServerMessage>(serverTx, value.counter, value.ciphertext, aad);
          receiveCounter += 1;
          applyMessage(message);
        } catch (error) {
          setState((current) => ({ ...current, error: error instanceof Error ? error.message : String(error) }));
          socket?.close();
        }
      };
      socket.onclose = (event) => {
        setState((current) => ({
          ...current,
          connected: false,
          ...(event.code === 1008 ? { error: "设备身份已失效或被撤销，请重新配对。" } : {}),
        }));
        if (!disposed && event.code !== 1008) reconnectTimer = window.setTimeout(() => connect(credentials), 1_500);
      };
    };

    void loadCredentials().then(({ credentials, localAdmin }) => {
      if (disposed) return;
      setState((current) => ({ ...current, localAdmin, pairingRequired: !credentials }));
      if (credentials) connect(credentials);
    }).catch((error: unknown) => {
      setState((current) => ({ ...current, pairingRequired: true, error: error instanceof Error ? error.message : String(error) }));
    });

    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  const send = useCallback((command: ClientCommand) => sendRef.current(command), []);
  const dismissNotice = useCallback(() => setState((current) => ({ ...current, notice: null })), []);
  const forgetDevice = useCallback(async () => {
    await clearCredentials();
    window.location.reload();
  }, []);
  return { ...state, send, dismissNotice, forgetDevice };
}
