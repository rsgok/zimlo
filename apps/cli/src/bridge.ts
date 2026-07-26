import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import QRCode from "qrcode";
import { FEATURE_CAPABILITIES, type ClientCommand, type ServerMessage } from "@zimlo/protocol";
import { ActionBroker } from "./action-broker.js";
import { codexPluginDeepLink, inspectCodexPlugin, installCodexPlugin } from "./codex-plugin.js";
import { DeviceManager } from "./device-manager.js";
import { inspectIntegrationStatuses, installCliIntegrations } from "./integration-status.js";
import { isLoopbackAddress, isTrustedLanAddress, preferredLanAddress } from "./network.js";
import { RuntimeHub } from "./runtime.js";
import { SecureSocket } from "./secure-socket.js";
import { TaskCommandService } from "./task-command-service.js";

interface PairBody {
  pairingId?: string;
  clientPublicKey?: string;
  proof?: string;
  name?: string;
}

export interface BridgeOptions {
  port: number;
  lan: boolean;
}

export class BridgeServer {
  private readonly runtime: RuntimeHub;
  private readonly broker: ActionBroker;
  private readonly devices: DeviceManager;
  private readonly taskCommands: TaskCommandService;
  private readonly options: BridgeOptions;
  private readonly entrypoint: string;
  private readonly connections = new Set<SecureSocket>();
  private app: FastifyInstance | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(input: {
    runtime: RuntimeHub;
    broker: ActionBroker;
    devices: DeviceManager;
    taskCommands: TaskCommandService;
    entrypoint: string;
    options: BridgeOptions;
  }) {
    this.runtime = input.runtime;
    this.broker = input.broker;
    this.devices = input.devices;
    this.taskCommands = input.taskCommands;
    this.entrypoint = input.entrypoint;
    this.options = input.options;
  }

  async start(): Promise<{ localUrl: string; lanUrl: string | null }> {
    const app = Fastify({ logger: false });
    this.app = app;
    await app.register(fastifyWebsocket);

    app.addHook("onRequest", async (request, reply) => {
      if (this.options.lan && !isTrustedLanAddress(request.ip)) {
        return reply.code(403).send({ error: "Zimlo only accepts trusted LAN addresses." });
      }
    });

    app.get("/healthz", async () => ({ ok: true, version: "0.2.0", protocolVersion: 2, features: FEATURE_CAPABILITIES }));
    app.get("/api/local-bootstrap", async (request, reply) => {
      if (!isLoopbackAddress(request.ip)) return reply.code(403).send({ error: "Loopback only" });
      const device = this.devices.localAdmin();
      return { deviceId: device.id, deviceKey: device.keyBase64 };
    });
    app.post("/api/pair", async (request, reply) => {
      const body = request.body as PairBody | null;
      if (!body?.pairingId || !body.clientPublicKey || !body.proof) {
        return reply.code(400).send({ error: "Invalid pairing request" });
      }
      const result = this.devices.completePairing({
        pairingId: body.pairingId,
        clientPublicKey: body.clientPublicKey,
        proof: body.proof,
        ...(body.name ? { name: body.name } : {}),
      });
      if (!result) return reply.code(410).send({ error: "Pairing expired, used, or invalid" });
      return { deviceId: result.device.id, serverProof: result.serverProof };
    });
    app.get("/ws", { websocket: true }, (socket) => {
      let connection: SecureSocket;
      connection = new SecureSocket({
        socket,
        devices: this.devices,
        onAuthenticated: (authenticated) => {
          this.connections.add(authenticated);
          authenticated.send({ type: "session.snapshot", snapshot: this.runtime.snapshot(authenticated.deviceId!) });
        },
        onCommand: (authenticated, command) => void this.handleCommand(authenticated, command),
      });
      socket.once("close", () => this.connections.delete(connection));
    });

    const publicRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../public");
    if (existsSync(publicRoot)) {
      // Keep a wildcard route so newly built, content-hashed assets are served
      // without requiring Fastify to have seen their filenames at startup.
      await app.register(fastifyStatic, { root: publicRoot });
      app.setNotFoundHandler((request, reply) => {
        if (request.method === "GET") return reply.sendFile("index.html");
        return reply.code(404).send({ error: "Not found" });
      });
    }

    this.unsubscribe = this.runtime.onMessage((message) => this.broadcast(message));
    await app.listen({ port: this.options.port, host: this.options.lan ? "0.0.0.0" : "127.0.0.1" });
    const localUrl = `http://127.0.0.1:${this.options.port}`;
    const address = this.options.lan ? preferredLanAddress() : null;
    return { localUrl, lanUrl: address ? `http://${address}:${this.options.port}` : null };
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const connection of this.connections) connection.close();
    this.connections.clear();
    await this.app?.close();
    this.app = null;
  }

  private broadcast(message: ServerMessage): void {
    for (const connection of this.connections) connection.send(message);
  }

  private async handleCommand(connection: SecureSocket, command: ClientCommand): Promise<void> {
    const deviceId = connection.deviceId;
    if (!deviceId) return;
    switch (command.type) {
      case "snapshot.request":
        connection.send({ type: "session.snapshot", snapshot: this.runtime.snapshot(deviceId) });
        return;
      case "user.profile.update": {
        const userProfile = this.runtime.store.updateUserProfile(command.avatarId);
        this.broadcast({ type: "user.profile.updated", userProfile });
        return;
      }
      case "session.events.request":
        connection.send({
          type: "session.events",
          sessionId: command.sessionId,
          events: this.runtime.store.listEvents(command.sessionId),
        });
        return;
      case "devices.request":
        if (!connection.isLocalAdmin) return connection.send({ type: "error", code: "forbidden", message: "仅 Mac 本机管理页可查看设备。" });
        connection.send({
          type: "devices.list",
          devices: this.devicesList(),
        });
        return;
      case "integrations.request":
        if (!connection.isLocalAdmin) return connection.send({ type: "error", code: "forbidden", message: "仅 Mac 本机管理页可查看本地 Agent 接入状态。" });
        connection.send({ type: "integrations.status", integrations: await inspectIntegrationStatuses(this.entrypoint) });
        return;
      case "integrations.cli.install":
        if (!connection.isLocalAdmin) return connection.send({ type: "error", code: "forbidden", message: "仅 Mac 本机管理页可修改本地 Agent 接入配置。" });
        try {
          await installCliIntegrations(this.entrypoint);
          connection.send({ type: "integrations.status", integrations: await inspectIntegrationStatuses(this.entrypoint) });
        } catch (error) {
          connection.send({ type: "error", code: "integration_install_failed", message: error instanceof Error ? error.message : String(error) });
        }
        return;
      case "device.approvals.set": {
        if (!connection.isLocalAdmin) return connection.send({ type: "error", code: "forbidden", message: "仅 Mac 本机管理页可授权手机审批。" });
        const device = this.runtime.store.setDeviceApproval(command.deviceId, command.enabled);
        if (!device) return connection.send({ type: "error", code: "device_not_found", message: "设备不存在或已撤销。" });
        connection.send({ type: "devices.list", devices: this.devicesList() });
        return;
      }
      case "device.trust.set": {
        if (!connection.isLocalAdmin) return connection.send({ type: "error", code: "forbidden", message: "仅 Mac 本机管理页可授权自动化策略管理。" });
        const device = this.runtime.store.setDeviceTrustManagement(command.deviceId, command.enabled);
        if (!device) return connection.send({ type: "error", code: "device_not_found", message: "设备不存在或已撤销。" });
        connection.send({ type: "devices.list", devices: this.devicesList() });
        return;
      }
      case "codex.plugin.request": {
        if (!connection.isLocalAdmin) return connection.send({ type: "error", code: "forbidden", message: "仅 Mac 本机管理页可查看 Codex 插件。" });
        const status = await inspectCodexPlugin(this.entrypoint);
        connection.send({
          type: "codex.plugin.status",
          installed: status.installed,
          detail: status.detail,
          pluginPath: status.paths.plugin,
          deepLink: codexPluginDeepLink(status.paths),
        });
        return;
      }
      case "codex.plugin.install": {
        if (!connection.isLocalAdmin) return connection.send({ type: "error", code: "forbidden", message: "仅 Mac 本机管理页可安装 Codex 插件。" });
        try {
          const status = await installCodexPlugin(this.entrypoint);
          connection.send({
            type: "codex.plugin.status",
            installed: status.installed,
            detail: "插件源已就绪。请在 Codex GUI 中安装 Zimlo，并审核 hooks。",
            pluginPath: status.paths.plugin,
            deepLink: codexPluginDeepLink(status.paths),
          });
        } catch (error) {
          connection.send({ type: "error", code: "codex_plugin_install_failed", message: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      case "action.decide": {
        const device = this.runtime.store.getDevice(deviceId);
        if (!connection.isLocalAdmin && !device?.canApprove) {
          return connection.send({ type: "action.result", actionId: command.actionId, ok: false, message: "这台手机尚未获得 Mac 的审批授权。" });
        }
        this.broker.decide({
          deviceId,
          actionId: command.actionId,
          sessionId: command.sessionId,
          decisionId: command.decisionId,
          idempotencyKey: command.idempotencyKey,
          ...(command.confirmationPhrase ? { confirmationPhrase: command.confirmationPhrase } : {}),
          ...(command.input ? { input: command.input } : {}),
        });
        return;
      }
      case "session.message": {
        const queued = this.taskCommands.followUp({
          deviceId,
          sessionId: command.sessionId,
          text: command.text,
          idempotencyKey: command.idempotencyKey,
        });
        connection.send({
          type: "session.message.result",
          sessionId: command.sessionId,
          ok: queued.state !== "failed",
          message: queued.state === "failed" ? queued.error ?? "任务无法继续。" : "指令已进入任务队列。",
        });
        return;
      }
      case "task.create": {
        this.taskCommands.create({
          deviceId,
          provider: command.provider,
          workspaceId: command.workspaceId,
          text: command.text,
          idempotencyKey: command.idempotencyKey,
        });
        return;
      }
      case "task.follow_up": {
        this.taskCommands.followUp({
          deviceId,
          sessionId: command.sessionId,
          text: command.text,
          idempotencyKey: command.idempotencyKey,
        });
        return;
      }
      case "task.command.retry": {
        const retried = this.taskCommands.retry(command.commandId);
        if (retried) connection.send({ type: "task.command.updated", command: retried });
        else connection.send({ type: "error", code: "task_command_not_found", message: "这条任务指令已不存在。" });
        return;
      }
      case "feed.seen": {
        this.runtime.store.markFeedSeen(deviceId, command.postId);
        connection.send({ type: "feed.seen.updated", postId: command.postId });
        return;
      }
      case "feed.dismiss": {
        this.runtime.store.dismissFeedItem(deviceId, command.itemId);
        connection.send({ type: "feed.dismissed.updated", itemId: command.itemId });
        return;
      }
      case "task.timeline.seen": {
        this.runtime.store.markTaskTimelineSeen(deviceId, command.sessionId, command.itemId);
        connection.send({ type: "task.timeline.seen.updated", sessionId: command.sessionId, itemId: command.itemId });
        return;
      }
      case "task.pin": {
        if (!this.runtime.store.getSession(command.sessionId)) return connection.send({ type: "error", code: "session_not_found", message: "这个任务已不存在。" });
        connection.send({ type: "task.preference.updated", preference: this.runtime.store.setTaskPinned(command.sessionId, command.pinned) });
        return;
      }
      case "task.archive": {
        if (!this.runtime.store.getSession(command.sessionId)) return connection.send({ type: "error", code: "session_not_found", message: "这个任务已不存在。" });
        connection.send({ type: "task.preference.updated", preference: this.runtime.store.setTaskArchived(command.sessionId, command.archived) });
        return;
      }
      case "review.list":
        connection.send({ type: "reviews.list", reviews: this.runtime.store.listTaskReviews(command.sessionId) });
        return;
      case "review.respond": {
        const storageKey = `${deviceId}:${command.idempotencyKey}`;
        const prior = this.runtime.store.getIdempotentResult(storageKey);
        if (prior) {
          const existing = this.runtime.store.getTaskReview(command.reviewId);
          if (existing) connection.send({ type: "review.updated", review: existing });
          return;
        }
        const current = this.runtime.store.getTaskReview(command.reviewId);
        if (!current) return connection.send({ type: "error", code: "review_not_found", message: "这份结果审阅已不存在。" });
        if (current.legacy || current.state !== "unreviewed") {
          return connection.send({ type: "error", code: "review_not_actionable", message: "这份结果已经处理或被新版本替代。" });
        }
        if (command.decision === "request_changes" && !command.note?.trim()) {
          return connection.send({ type: "error", code: "review_note_required", message: "请说明需要修改的内容。" });
        }
        if (command.decision === "request_changes") {
          const queued = this.taskCommands.followUp({
            deviceId,
            sessionId: current.sessionId,
            text: command.note!.trim(),
            idempotencyKey: `review:${command.idempotencyKey}`,
          });
          if (queued.state === "failed") {
            return connection.send({ type: "error", code: "review_follow_up_failed", message: queued.error ?? "修改要求未能进入任务队列。" });
          }
        }
        const review = this.runtime.store.respondToTaskReview({
          reviewId: command.reviewId,
          decision: command.decision,
          ...(command.note ? { note: command.note } : {}),
          deviceId,
          updatedAt: new Date().toISOString(),
        });
        if (!review) return connection.send({ type: "error", code: "review_not_found", message: "这份结果审阅已不存在。" });
        this.runtime.store.saveIdempotentResult(storageKey, review.id, { ok: true });
        this.broadcast({ type: "review.updated", review });
        return;
      }
      case "trust.policy.get":
        connection.send({
          type: "trust.policies",
          policies: command.projectId ? [this.runtime.store.getTrustPolicy(command.projectId)] : this.runtime.store.listTrustPolicies(),
          audit: this.runtime.store.listTrustAudit(command.projectId),
        });
        return;
      case "trust.policy.update": {
        const device = this.runtime.store.getDevice(deviceId);
        if (!connection.isLocalAdmin && !device?.canManageTrust) {
          return connection.send({ type: "error", code: "forbidden", message: "这台设备没有修改自动化策略的权限。" });
        }
        if (!this.runtime.store.getProject(command.projectId)) {
          return connection.send({ type: "error", code: "project_not_found", message: "这个 Project 已不存在。" });
        }
        const policy = this.runtime.store.updateTrustPolicy(command.projectId, command.preset, deviceId);
        this.runtime.store.saveIdempotentResult(`${deviceId}:${command.idempotencyKey}`, policy.projectId, { ok: true });
        this.broadcast({ type: "trust.policy.updated", policy });
        return;
      }
      case "notification.settings.get":
        connection.send({ type: "notification.settings.updated", settings: this.runtime.store.getNotificationSettings(deviceId) });
        return;
      case "notification.settings.update": {
        const settings = this.runtime.store.updateNotificationSettings(deviceId, command.settings);
        this.runtime.store.saveIdempotentResult(`${deviceId}:${command.idempotencyKey}`, deviceId, { ok: true });
        connection.send({ type: "notification.settings.updated", settings });
        return;
      }
      case "notification.device.register": {
        const registration = this.runtime.store.upsertPushDevice(deviceId, command.endpoint, command.publicKey);
        this.runtime.store.saveIdempotentResult(`${deviceId}:${command.idempotencyKey}`, deviceId, { ok: true });
        connection.send({ type: "notification.device.updated", registration });
        return;
      }
      case "notification.device.unregister":
        this.runtime.store.unregisterPushDevice(deviceId);
        this.runtime.store.saveIdempotentResult(`${deviceId}:${command.idempotencyKey}`, deviceId, { ok: true });
        connection.send({ type: "notification.device.updated", registration: null });
        return;
      case "agent.profile.update": {
        const project = this.runtime.store.updateAgentProfile(command.projectId, {
          displayName: command.displayName,
          avatar: command.avatar,
          bio: command.bio,
          defaultProvider: command.defaultProvider,
        });
        if (!project) return connection.send({ type: "error", code: "project_not_found", message: "这个 Project 已不存在。" });
        // Project Agent identity is shared by every task Timeline for this
        // project, so every connected device must receive the new profile.
        this.broadcast({ type: "project.updated", project });
        return;
      }
      case "pairing.create": {
        if (!connection.isLocalAdmin) return connection.send({ type: "error", code: "forbidden", message: "仅 Mac 本机管理页可创建配对。" });
        const host = preferredLanAddress();
        if (!this.options.lan || !host) return connection.send({ type: "error", code: "lan_disabled", message: "请使用 zimlo start --lan 启动。" });
        const result = this.devices.createPairing(`http://${host}:${this.options.port}`);
        connection.send({
          type: "pairing.created",
          pairUrl: result.pairUrl,
          qrDataUrl: await QRCode.toDataURL(result.pairUrl, { margin: 1, width: 320 }),
          expiresAt: result.expiresAt,
        });
        return;
      }
      case "lan.approvals.set":
        if (!connection.isLocalAdmin) return connection.send({ type: "error", code: "forbidden", message: "仅 Mac 本机管理页可开启 LAN 审批。" });
        this.runtime.setLanApprovals(command.enabled);
        for (const device of this.runtime.store.listDevices()) {
          if (!device.isLocalAdmin && !device.revokedAt) this.runtime.store.setDeviceApproval(device.id, command.enabled);
        }
        connection.send({ type: "devices.list", devices: this.devicesList() });
        return;
    }
  }

  private devicesList() {
    return this.runtime.store.listDevices().map(({ keyBase64: _keyBase64, ...device }) => device);
  }
}
