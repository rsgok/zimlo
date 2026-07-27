import { useCallback, useEffect, useRef, useState } from "react";
import { EMPTY_FEATURE_CAPABILITIES, type ClientCommand, type IntegrationStatus, type ServerMessage, type Snapshot, type UnifiedEvent } from "@zimlo/protocol";
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
  readCachedSnapshot,
  readCredentials,
  saveCachedSnapshot,
  saveCredentials,
  type DeviceCredentials,
} from "../lib/credentials";
import { isInternalZimloAction, normalizeFeedPost, normalizeSnapshot } from "../lib/feedCompatibility";
import {
  enqueueCommand,
  isDurableCommand,
  readCommandOutbox,
  removeAcknowledged,
  saveCommandOutbox,
  type CommandOutboxEntry,
} from "../lib/commandOutbox";

const EMPTY_SNAPSHOT: Snapshot = {
  userProfile: { avatarId: "user-01", updatedAt: "" },
  projects: [],
  sessions: [],
  cards: [],
  posts: [],
  tasks: [],
  commands: [],
  workspaces: [],
  seenPostIds: [],
  dismissedFeedItemIds: [],
  taskTimelineCursors: {},
  taskPreferences: [],
  actions: [],
  reviews: [],
  trustPolicies: [],
  trustAudit: [],
  notificationSettings: { enabled: false, approvals: true, failures: true, reviews: true, showTaskTitle: false, updatedAt: "" },
  pushDevices: [],
  features: EMPTY_FEATURE_CAPABILITIES,
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
  canApprove: boolean;
  canManageTrust: boolean;
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
  integrations: IntegrationStatus[];
  connected: boolean;
  connectionMode: "offline" | "local" | "cloud";
  pairingRequired: boolean;
  localAdmin: boolean;
  error: string | null;
  notice: string | null;
  pendingOutboxCount: number;
  pendingCommandEntries: CommandOutboxEntry[];
}

function isLocalHost(): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(window.location.hostname);
}

async function pairFromFragment(): Promise<DeviceCredentials | null> {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const pairingId = params.get("pairingId");
  const secretText = params.get("secret");
  const bridgeKeyText = params.get("bridgeKey");
  const pairingToken = params.get("pairingToken");
  if (!pairingId || !secretText || !bridgeKeyText) return null;
  const secret = fromBase64Url(secretText);
  const pair = createKeyPair();
  const pairKey = derivePairKey(pair.privateKey, fromBase64Url(bridgeKeyText), secret);
  let response = await fetch("/api/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pairingId,
      ...(pairingToken ? { pairingToken } : {}),
      clientPublicKey: toBase64Url(pair.publicKey),
      proof: makeProof(pairKey, `client:${pairingId}`),
      name: `${navigator.platform || "Mobile"} browser`,
    }),
  });
  if (response.status === 202 && pairingToken) {
    const pending = await response.json() as { requestId: string };
    const deadline = Date.now() + 60_000;
    do {
      await new Promise((resolve) => window.setTimeout(resolve, 500));
      const query = new URLSearchParams({
        pairingId,
        pairingToken,
        requestId: pending.requestId,
      });
      response = await fetch(`/api/pair?${query.toString()}`);
    } while (response.status === 202 && Date.now() < deadline);
  }
  if (!response.ok) throw new Error("配对链接已过期、已使用或校验失败。请在 Mac 上重新生成。");
  const result = await response.json() as {
    deviceId: string;
    serverProof: string;
    cloud?: { relayURL: string; accessToken: string };
  };
  if (!verifyProof(pairKey, `server:${result.deviceId}`, result.serverProof)) throw new Error("Bridge 配对证明无效。");
  const credentials: DeviceCredentials = {
    deviceId: result.deviceId,
    deviceKey: toBase64Url(deriveDeviceKey(pairKey, secret)),
    ...(result.cloud ? {
      remoteRelayURL: result.cloud.relayURL,
      remoteAccessToken: result.cloud.accessToken,
    } : {}),
  };
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
  const outboxRef = useRef<CommandOutboxEntry[]>(readCommandOutbox());
  const rawSendRef = useRef<(command: ClientCommand) => boolean>(() => false);
  const [state, setState] = useState<BridgeState>({
    snapshot: EMPTY_SNAPSHOT,
    events: {},
    devices: [],
    pairing: null,
    codexPlugin: null,
    integrations: [],
    connected: false,
    connectionMode: "offline",
    pairingRequired: false,
    localAdmin: false,
    error: null,
    notice: null,
    pendingOutboxCount: outboxRef.current.length,
    pendingCommandEntries: outboxRef.current,
  });
  const sendRef = useRef<(command: ClientCommand) => boolean>(() => false);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;

    const replaceOutbox = (entries: CommandOutboxEntry[]) => {
      outboxRef.current = entries;
      saveCommandOutbox(entries);
      setState((current) => ({ ...current, pendingOutboxCount: entries.length, pendingCommandEntries: entries }));
    };

    const acknowledge = (message: ServerMessage) => {
      const next = removeAcknowledged(outboxRef.current, (entry) => {
        const command = entry.command;
        switch (message.type) {
          case "task.command.updated":
            if (command.type === "task.command.retry") return message.command.id === command.commandId;
            return (command.type === "task.create" || command.type === "task.follow_up" || command.type === "session.message")
              && (message.command.idempotencyKey === command.idempotencyKey || message.command.idempotencyKey.endsWith(`:${command.idempotencyKey}`));
          case "action.result":
            return message.ok && command.type === "action.decide" && command.actionId === message.actionId;
          case "session.message.result":
            return message.ok && command.type === "session.message" && command.sessionId === message.sessionId;
          case "feed.dismissed.updated":
            return command.type === "feed.dismiss" && command.itemId === message.itemId;
          case "project.updated":
            return command.type === "agent.profile.update"
              && command.projectId === message.project.id
              && command.displayName === message.project.agentProfile.displayName
              && command.avatar === message.project.agentProfile.avatar
              && command.bio === message.project.agentProfile.bio
              && command.defaultProvider === message.project.agentProfile.defaultProvider;
          case "user.profile.updated":
            return command.type === "user.profile.update" && command.avatarId === message.userProfile.avatarId;
          case "review.updated":
            return command.type === "review.respond" && command.reviewId === message.review.id;
          case "trust.policy.updated":
            return command.type === "trust.policy.update" && command.projectId === message.policy.projectId;
          case "notification.settings.updated":
            return command.type === "notification.settings.update";
          case "notification.device.updated":
            return command.type === "notification.device.register" || command.type === "notification.device.unregister";
          default:
            return false;
        }
      });
      if (next.length !== outboxRef.current.length) replaceOutbox(next);
    };

    sendRef.current = (command) => {
      if (!isDurableCommand(command)) {
        const sent = rawSendRef.current(command);
        if (!sent) setState((current) => ({ ...current, notice: "Bridge 尚未连接，请稍后重试。" }));
        return sent;
      }
      const queued = enqueueCommand(outboxRef.current, command);
      if (!saveCommandOutbox(queued.entries)) {
        setState((current) => ({ ...current, error: "无法在本机保存这条指令，请保留当前页面后重试。" }));
        return false;
      }
      outboxRef.current = queued.entries;
      const sent = rawSendRef.current(queued.entry.command);
      setState((current) => ({
        ...current,
        pendingOutboxCount: queued.entries.length,
        pendingCommandEntries: queued.entries,
        notice: sent
          ? (queued.added ? "指令已发送，等待 Bridge 确认。" : "这条指令已在队列中，不会重复发送。")
          : "指令已保存在本机，将在重连后自动发送。",
      }));
      return true;
    };

    const applyMessage = (message: ServerMessage) => {
      acknowledge(message);
      setState((current) => {
        switch (message.type) {
          case "session.snapshot":
            return { ...current, snapshot: normalizeSnapshot(message.snapshot), error: null };
          case "project.updated":
            return { ...current, snapshot: { ...current.snapshot, projects: upsertById(current.snapshot.projects, message.project) } };
          case "user.profile.updated":
            return { ...current, snapshot: { ...current.snapshot, userProfile: message.userProfile } };
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
          case "feed.posted": {
            const post = normalizeFeedPost(message.post);
            return post
              ? { ...current, snapshot: { ...current.snapshot, posts: upsertById(current.snapshot.posts, post) } }
              : current;
          }
          case "task.updated":
            return { ...current, snapshot: { ...current.snapshot, tasks: upsertById(current.snapshot.tasks, message.task) } };
          case "task.command.updated":
            return { ...current, snapshot: { ...current.snapshot, commands: upsertById(current.snapshot.commands, message.command) } };
          case "feed.seen.updated":
            return current.snapshot.seenPostIds.includes(message.postId)
              ? current
              : { ...current, snapshot: { ...current.snapshot, seenPostIds: [...current.snapshot.seenPostIds, message.postId] } };
          case "feed.dismissed.updated":
            return current.snapshot.dismissedFeedItemIds.includes(message.itemId)
              ? current
              : { ...current, snapshot: { ...current.snapshot, dismissedFeedItemIds: [...current.snapshot.dismissedFeedItemIds, message.itemId] } };
          case "task.timeline.seen.updated":
            return { ...current, snapshot: { ...current.snapshot, taskTimelineCursors: { ...current.snapshot.taskTimelineCursors, [message.sessionId]: message.itemId } } };
          case "task.preference.updated":
            return { ...current, snapshot: { ...current.snapshot, taskPreferences: upsertById(current.snapshot.taskPreferences.map((preference) => ({ ...preference, id: preference.sessionId })), { ...message.preference, id: message.preference.sessionId }).map(({ id: _id, ...preference }) => preference) } };
          case "review.updated":
            return { ...current, snapshot: { ...current.snapshot, reviews: upsertById(current.snapshot.reviews, message.review) } };
          case "reviews.list":
            return { ...current, snapshot: { ...current.snapshot, reviews: message.reviews } };
          case "trust.policy.updated":
            return {
              ...current,
              snapshot: {
                ...current.snapshot,
                trustPolicies: upsertById(
                  current.snapshot.trustPolicies.map((policy) => ({ ...policy, id: policy.projectId })),
                  { ...message.policy, id: message.policy.projectId },
                ).map(({ id: _id, ...policy }) => policy),
              },
            };
          case "trust.policies":
            return { ...current, snapshot: { ...current.snapshot, trustPolicies: message.policies, trustAudit: message.audit } };
          case "notification.settings.updated":
            return { ...current, snapshot: { ...current.snapshot, notificationSettings: message.settings } };
          case "notification.device.updated":
            return {
              ...current,
              snapshot: {
                ...current.snapshot,
                pushDevices: message.registration ? [message.registration] : [],
              },
            };
          case "action.upsert": {
            if (isInternalZimloAction(message.action)) {
              return {
                ...current,
                snapshot: {
                  ...current.snapshot,
                  actions: current.snapshot.actions.filter((action) => action.actionId !== message.action.actionId),
                },
              };
            }
            const actions = upsertById(
              current.snapshot.actions.map((action) => ({ ...action, id: action.actionId })),
              { ...message.action, id: message.action.actionId },
            ).map(({ id: _id, ...action }) => action);
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
          case "integrations.status":
            return { ...current, integrations: message.integrations };
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

    const connect = (credentials: DeviceCredentials, mode: "local" | "cloud" = "local") => {
      if (disposed) return;
      const remote = mode === "cloud";
      const url = new URL(
        remote ? "/v1/sync/device" : "/ws",
        remote ? credentials.remoteRelayURL : window.location.href,
      );
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      socket = remote
        ? new WebSocket(url, ["zimlo-relay-v1", `zimlo-token.${credentials.remoteAccessToken}`])
        : new WebSocket(url);
      let clientTx: Uint8Array | null = null;
      let serverTx: Uint8Array | null = null;
      let sendCounter = 0;
      let receiveCounter = 0;
      const clientNonce = randomBytes(24);
      const clientNonceText = toBase64Url(clientNonce);
      const deviceKey = fromBase64Url(credentials.deviceKey);
      const aad = `zimlo-ws-v1:${credentials.deviceId}`;

      rawSendRef.current = (command) => {
        if (!socket || socket.readyState !== WebSocket.OPEN || !clientTx) {
          return false;
        }
        const counter = sendCounter;
        sendCounter += 1;
        socket.send(JSON.stringify({ type: "secure", counter, ciphertext: encryptFrame(clientTx, counter, command, aad) }));
        return true;
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
            setState((current) => ({ ...current, connected: true, connectionMode: mode, error: null }));
            for (const entry of outboxRef.current) rawSendRef.current(entry.command);
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
        rawSendRef.current = () => false;
        setState((current) => ({
          ...current,
          connected: false,
          connectionMode: "offline",
          ...(event.code === 1008 ? { error: "设备身份已失效或被撤销，请重新配对。" } : {}),
        }));
        if (!disposed && event.code !== 1008) {
          const nextMode = credentials.remoteRelayURL && credentials.remoteAccessToken
            ? (mode === "local" ? "cloud" : "local")
            : "local";
          reconnectTimer = window.setTimeout(() => connect(credentials, nextMode), 1_500);
        }
      };
    };

    void readCachedSnapshot().then((cached) => {
      if (cached && !disposed) {
        setState((current) => current.snapshot.sequence > 0
          ? current
          : { ...current, snapshot: normalizeSnapshot(cached) });
      }
      return loadCredentials();
    }).then(({ credentials, localAdmin }) => {
      if (disposed) return;
      setState((current) => ({ ...current, localAdmin, pairingRequired: !credentials }));
      if (credentials) connect(credentials);
    }).catch((error: unknown) => {
      setState((current) => ({ ...current, pairingRequired: true, error: error instanceof Error ? error.message : String(error) }));
    });

    return () => {
      disposed = true;
      rawSendRef.current = () => false;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  useEffect(() => {
    if (state.snapshot.sequence > 0) void saveCachedSnapshot(state.snapshot);
  }, [state.snapshot]);

  const send = useCallback((command: ClientCommand) => sendRef.current(command), []);
  const dismissNotice = useCallback(() => setState((current) => ({ ...current, notice: null })), []);
  const forgetDevice = useCallback(async () => {
    await clearCredentials();
    window.location.reload();
  }, []);
  return { ...state, send, dismissNotice, forgetDevice };
}
