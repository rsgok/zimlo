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
  clearDeviceLocalData,
  enqueueCommand,
  isDurableCommand,
  isOutboxEntryCancelable,
  outboxEntryIdempotencyKey,
  patchOutboxEntries,
  readCommandOutbox,
  removeAcknowledged,
  saveCommandOutbox,
  type CommandOutboxEntry,
} from "../lib/commandOutbox";
import { ReconnectController } from "../lib/reconnect";

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
  /** 已连续重连失败的次数（下一次尝试的序号） */
  reconnectAttempt: number;
  /** 下一次自动重试的时间戳；无计划时为 null */
  nextRetryAt: number | null;
  /** 因设备离线而暂停重连计时 */
  reconnectPausedOffline: boolean;
  /** 当前快照的落盘/到达时间，断线时展示"数据更新于 X 分钟前" */
  snapshotSavedAt: string | null;
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

// 快照到达时按权威状态吸收 outbox 意图（dismiss 两个方向、pin/archive）。
function snapshotSatisfies(command: ClientCommand, snapshot: Snapshot): boolean {
  switch (command.type) {
    case "feed.dismiss":
      return snapshot.dismissedFeedItemIds.includes(command.itemId);
    case "feed.dismiss.set":
      return snapshot.dismissedFeedItemIds.includes(command.itemId) === command.dismissed;
    case "task.pin": {
      const preference = snapshot.taskPreferences.find((candidate) => candidate.sessionId === command.sessionId);
      return Boolean(preference?.pinnedAt) === command.pinned;
    }
    case "task.archive": {
      const preference = snapshot.taskPreferences.find((candidate) => candidate.sessionId === command.sessionId);
      return Boolean(preference?.archivedAt) === command.archived;
    }
    default:
      return false;
  }
}

export function useBridge() {
  const outboxRef = useRef<CommandOutboxEntry[]>(readCommandOutbox());
  const rawSendRef = useRef<(command: ClientCommand) => boolean>(() => false);
  const reconnectRef = useRef<ReconnectController | null>(null);
  const snapshotPersistRef = useRef<{ timer: number | null; latest: Snapshot | null }>({ timer: null, latest: null });
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
    reconnectAttempt: 0,
    nextRetryAt: null,
    reconnectPausedOffline: false,
    snapshotSavedAt: null,
  });
  const sendRef = useRef<(command: ClientCommand) => boolean>(() => false);

  const replaceOutbox = useCallback((entries: CommandOutboxEntry[]) => {
    outboxRef.current = entries;
    saveCommandOutbox(entries);
    setState((current) => ({ ...current, pendingOutboxCount: entries.length, pendingCommandEntries: entries }));
  }, []);

  const markOutboxFailed = useCallback((predicate: (entry: CommandOutboxEntry) => boolean, message: string) => {
    const next = patchOutboxEntries(outboxRef.current, predicate, (entry) => ({ ...entry, state: "failed" as const, error: message }));
    if (next !== outboxRef.current) replaceOutbox(next);
  }, [replaceOutbox]);

  const cancelOutboxEntry = useCallback((entryId: string): boolean => {
    const entry = outboxRef.current.find((candidate) => candidate.id === entryId);
    if (!entry || !isOutboxEntryCancelable(entry)) return false;
    const idempotencyKey = outboxEntryIdempotencyKey(entry);
    if (entry.state !== "queued" && idempotencyKey) {
      // 先把撤回意图加入持久 outbox；只有落盘成功后才移除原指令。
      if (!sendRef.current({ type: "task.command.cancel", idempotencyKey })) return false;
    }
    replaceOutbox(removeAcknowledged(outboxRef.current, (candidate) => candidate.id === entryId));
    return true;
  }, [replaceOutbox]);

  const retryOutboxEntry = useCallback((entryId: string): boolean => {
    const entry = outboxRef.current.find((candidate) => candidate.id === entryId);
    if (!entry) return false;
    const sent = rawSendRef.current(entry.command);
    replaceOutbox(patchOutboxEntries(outboxRef.current, (candidate) => candidate.id === entryId, (candidate) => {
      const next = { ...candidate, state: (sent ? "sent" : "queued") as CommandOutboxEntry["state"] & string };
      delete next.error;
      return next;
    }));
    return sent;
  }, [replaceOutbox]);

  const removeOutboxEntry = useCallback((entryId: string): void => {
    replaceOutbox(removeAcknowledged(outboxRef.current, (candidate) => candidate.id === entryId));
  }, [replaceOutbox]);

  const retryReconnectNow = useCallback(() => reconnectRef.current?.retryNow(), []);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let credentialsValue: DeviceCredentials | null = null;
    let nextMode: "local" | "cloud" = "local";

    const controller = new ReconnectController(
      {
        connect: () => {
          if (credentialsValue) connect(credentialsValue, nextMode);
        },
        isOnline: () => navigator.onLine,
        setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
        clearTimeout: (id) => window.clearTimeout(id),
        random: Math.random,
      },
      () => Boolean(credentialsValue?.remoteRelayURL && credentialsValue?.remoteAccessToken),
      (reconnect) => setState((current) => ({
        ...current,
        reconnectAttempt: reconnect.attempt,
        nextRetryAt: reconnect.nextRetryAt,
        reconnectPausedOffline: reconnect.pausedOffline,
      })),
    );
    reconnectRef.current = controller;

    const acknowledge = (message: ServerMessage) => {
      const next = removeAcknowledged(outboxRef.current, (entry) => {
        const command = entry.command;
        switch (message.type) {
          case "task.command.updated":
            if (command.type === "task.command.retry") return message.command.id === command.commandId;
            return (command.type === "task.create" || command.type === "task.follow_up" || command.type === "session.message")
              && (message.command.idempotencyKey === command.idempotencyKey || message.command.idempotencyKey.endsWith(`:${command.idempotencyKey}`));
          case "task.command.cancel.result":
            return command.type === "task.command.cancel"
              && ((message.commandId !== undefined && command.commandId === message.commandId)
                || (message.idempotencyKey !== undefined && command.idempotencyKey === message.idempotencyKey));
          case "action.result":
            return command.type === "action.decide" && command.actionId === message.actionId;
          case "session.message.result":
            return message.ok && command.type === "session.message" && command.sessionId === message.sessionId;
          case "feed.dismissed.updated":
            return (command.type === "feed.dismiss" && command.itemId === message.itemId)
              || (command.type === "feed.dismiss.set" && command.itemId === message.itemId && command.dismissed);
          case "task.preference.updated":
            return (command.type === "task.pin" && command.sessionId === message.preference.sessionId && command.pinned === Boolean(message.preference.pinnedAt))
              || (command.type === "task.archive" && command.sessionId === message.preference.sessionId && command.archived === Boolean(message.preference.archivedAt));
          case "session.snapshot":
            return snapshotSatisfies(command, message.snapshot);
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
      // 语义键去重命中且已发送过的条目不重复发送（服务端始终只执行一次）；
      // 替换型命令（最新意图胜出）或失败条目会重新发送。
      const shouldSend = queued.added || queued.entry.state !== "sent";
      const sent = shouldSend && rawSendRef.current(queued.entry.command);
      const stamped = patchOutboxEntries(queued.entries, (entry) => entry.id === queued.entry.id, (entry) => ({
        ...entry,
        state: (sent || !shouldSend ? "sent" : "queued") as CommandOutboxEntry["state"] & string,
      }));
      if (stamped !== queued.entries) {
        outboxRef.current = stamped;
        saveCommandOutbox(stamped);
      }
      setState((current) => ({
        ...current,
        pendingOutboxCount: outboxRef.current.length,
        pendingCommandEntries: outboxRef.current,
        notice: sent || !shouldSend
          ? (queued.added ? "指令已发送，等待 Bridge 确认。" : "这条指令已在队列中，不会重复发送。")
          : "指令已保存在本机，将在重连后自动发送。",
      }));
      return true;
    };

    const applyMessage = (message: ServerMessage) => {
      acknowledge(message);
      switch (message.type) {
        case "session.message.result":
          if (!message.ok) markOutboxFailed((entry) => entry.command.type === "session.message" && entry.command.sessionId === message.sessionId, message.message);
          break;
        default:
          break;
      }
      setState((current) => {
        switch (message.type) {
          case "session.snapshot":
            return { ...current, snapshot: normalizeSnapshot(message.snapshot), error: null, snapshotSavedAt: new Date().toISOString() };
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
          case "task.command.cancel.result":
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
            controller.notifyConnected();
            setState((current) => ({ ...current, connected: true, connectionMode: mode, error: null }));
            // 重连重放：失败条目等用户处理，其余按原幂等键重发。
            const replayed = patchOutboxEntries(outboxRef.current, (entry) => entry.state !== "failed", (entry) => ({ ...entry, state: "sent" as const }));
            for (const entry of replayed) {
              if (entry.state === "sent") rawSendRef.current(entry.command);
            }
            if (replayed !== outboxRef.current) replaceOutbox(replayed);
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
          const hasRemote = Boolean(credentials.remoteRelayURL && credentials.remoteAccessToken);
          nextMode = hasRemote ? (mode === "local" ? "cloud" : "local") : "local";
          controller.notifyDisconnected();
        }
      };
    };

    const onForeground = () => {
      if (document.visibilityState === "visible") controller.notifyForeground();
    };
    const onOnline = () => controller.notifyOnline();
    const onOffline = () => controller.notifyOffline();
    document.addEventListener("visibilitychange", onForeground);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    void readCachedSnapshot().then((cached) => {
      if (cached && !disposed) {
        setState((current) => current.snapshot.sequence > 0
          ? current
          : { ...current, snapshot: normalizeSnapshot(cached.snapshot), snapshotSavedAt: cached.savedAt });
      }
      return loadCredentials();
    }).then(({ credentials, localAdmin }) => {
      if (disposed) return;
      credentialsValue = credentials;
      setState((current) => ({ ...current, localAdmin, pairingRequired: !credentials }));
      if (credentials) {
        nextMode = "local";
        connect(credentials, "local");
      }
    }).catch((error: unknown) => {
      setState((current) => ({ ...current, pairingRequired: true, error: error instanceof Error ? error.message : String(error) }));
    });

    return () => {
      disposed = true;
      rawSendRef.current = () => false;
      controller.dispose();
      reconnectRef.current = null;
      document.removeEventListener("visibilitychange", onForeground);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      socket?.close();
    };
  }, [markOutboxFailed, replaceOutbox]);

  // 快照落盘节流：1.5s trailing debounce，最多每 1.5s 全量序列化一次；卸载时 flush。
  useEffect(() => {
    if (state.snapshot.sequence === 0) return;
    const persist = snapshotPersistRef.current;
    persist.latest = state.snapshot;
    if (persist.timer !== null) return;
    persist.timer = window.setTimeout(() => {
      persist.timer = null;
      const latest = persist.latest;
      persist.latest = null;
      if (latest) void saveCachedSnapshot(latest);
    }, 1_500);
  }, [state.snapshot]);

  useEffect(() => () => {
    const persist = snapshotPersistRef.current;
    if (persist.timer !== null) window.clearTimeout(persist.timer);
    persist.timer = null;
    if (persist.latest) void saveCachedSnapshot(persist.latest);
    persist.latest = null;
  }, []);

  const send = useCallback((command: ClientCommand) => sendRef.current(command), []);
  const dismissNotice = useCallback(() => setState((current) => ({ ...current, notice: null })), []);
  const dismissError = useCallback(() => setState((current) => ({ ...current, error: null })), []);
  const forgetDevice = useCallback(async () => {
    await clearCredentials();
    clearDeviceLocalData();
    window.location.reload();
  }, []);
  return {
    ...state,
    send,
    dismissNotice,
    dismissError,
    forgetDevice,
    cancelOutboxEntry,
    retryOutboxEntry,
    removeOutboxEntry,
    retryReconnectNow,
  };
}
