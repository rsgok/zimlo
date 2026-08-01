import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import QRCode from "qrcode";
import type { ClientCommand, ServerMessage } from "@zimlo/protocol";
import { ActionBroker } from "./action-broker.js";
import { ApiError, classifyIntegrationError, classifyLocalApiError, sendApiError } from "./api-error.js";
import { CloudService } from "./cloud-service.js";
import { codexPluginDeepLink, inspectCodexPlugin, installCodexPlugin } from "./codex-plugin.js";
import { DeviceManager, type PairingResult } from "./device-manager.js";
import { applyFeedDismissSet } from "./feed-dismiss.js";
import { inspectIntegrationStatuses, installCliIntegrations } from "./integration-status.js";
import { isLoopbackAddress, isTrustedLanAddress, preferredLanAddress } from "./network.js";
import { pairingURLForBase, selectPairingEndpoint, type PairingTransport } from "./pairing-endpoint.js";
import { RuntimeHub } from "./runtime.js";
import { SecureSocket } from "./secure-socket.js";
import { TaskCommandService } from "./task-command-service.js";
import { setTaskArchivedIdempotent, setTaskPinnedIdempotent } from "./task-preferences.js";
import { ZIMLO_PROTOCOL_VERSION, ZIMLO_VERSION } from "./version.js";
import { MATERIAL_LIMITS, MaterialService } from "./material-service.js";

interface PairBody {
  pairingId?: string;
  clientPublicKey?: string;
  proof?: string;
  name?: string;
}

interface LocalIntegrationBody {
  target?: "all" | "codex_gui" | "cli";
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
  private readonly cloud: CloudService;
  private readonly materials: MaterialService;
  private readonly options: BridgeOptions;
  private readonly entrypoint: string;
  private readonly connections = new Set<SecureSocket>();
  private readonly pairingWatchers = new Map<string, AbortController>();
  private app: FastifyInstance | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(input: {
    runtime: RuntimeHub;
    broker: ActionBroker;
    devices: DeviceManager;
    taskCommands: TaskCommandService;
    cloud: CloudService;
    entrypoint: string;
    options: BridgeOptions;
  }) {
    this.runtime = input.runtime;
    this.broker = input.broker;
    this.devices = input.devices;
    this.taskCommands = input.taskCommands;
    this.cloud = input.cloud;
    this.materials = new MaterialService(input.runtime, input.cloud);
    this.entrypoint = input.entrypoint;
    this.options = input.options;
  }

  async start(): Promise<{ localUrl: string; lanUrl: string | null; port: number }> {
    const trace = (phase: string): void => {
      if (process.env.ZIMLO_STARTUP_TRACE === "1") console.error(`[zimlo:bridge] ${phase}`);
    };
    trace("create-fastify");
    const app = Fastify({ logger: false, bodyLimit: MATERIAL_LIMITS.video + 64 });
    this.app = app;
    trace("register-websocket");
    await app.register(fastifyWebsocket);
    app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => done(null, body));

    // Last-resort stable error shape: an unforeseen route failure must never
    // surface Fastify's default "Internal Server Error" to the macOS app.
    app.setErrorHandler((error: FastifyError, request, reply) => {
      console.error(`[zimlo:bridge] ${request.method} ${request.url} 未处理错误: ${error.message}`);
      return sendApiError(reply, new ApiError(
        "internal_error",
        "本地服务出现未预期错误，详情见日志。",
        500,
        true,
        "运行 zimlo logs 查看日志，或 zimlo doctor 检查环境。",
      ));
    });

    const loopbackOnly = () => ({ code: "loopback_only", message: "仅允许本机访问。", recoverable: false });

    app.addHook("onRequest", async (request, reply) => {
      if (this.options.lan && !isTrustedLanAddress(request.ip)) {
        return reply.code(403).send({ code: "lan_restricted", message: "Zimlo 只接受可信局域网地址。", recoverable: false });
      }
    });

    app.get("/healthz", async () => ({ ok: true, version: ZIMLO_VERSION, protocolVersion: ZIMLO_PROTOCOL_VERSION, features: this.runtime.features() }));
    app.put("/api/materials/:materialId/blob", async (request, reply) => {
      const materialId = (request.params as { materialId?: string }).materialId ?? "";
      const body = request.body;
      if (!Buffer.isBuffer(body)) return reply.code(400).send({ code: "material_body_required", message: "物料内容为空。" });
      const deviceId = String(request.headers["x-zimlo-device-id"] ?? "");
      if (!isLoopbackAddress(request.ip)) {
        const timestamp = String(request.headers["x-zimlo-timestamp"] ?? "");
        const proof = String(request.headers["x-zimlo-proof"] ?? "");
        if (!this.materials.verifyLocalProof(deviceId, materialId, timestamp, body.length, proof)) {
          return reply.code(401).send({ code: "material_upload_unauthorized", message: "物料上传认证失败。" });
        }
      }
      const owner = deviceId || this.devices.localAdmin().id;
      try {
        this.materials.receiveLocalBlob(owner, materialId, body);
        return reply.code(201).send({ ok: true, materialId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.code(message === "material_too_large" ? 413 : 400).send({ code: message, message: "物料上传失败。" });
      }
    });
    app.get("/api/materials/:materialId/content", async (request, reply) => {
      const materialId = (request.params as { materialId?: string }).materialId ?? "";
      if (!isLoopbackAddress(request.ip)) {
        const deviceId = String(request.headers["x-zimlo-device-id"] ?? "");
        const timestamp = String(request.headers["x-zimlo-timestamp"] ?? "");
        const proof = String(request.headers["x-zimlo-proof"] ?? "");
        if (!this.materials.verifyContentProof(deviceId, materialId, timestamp, proof)) {
          return reply.code(401).send({ code: "material_download_unauthorized", message: "物料读取认证失败。" });
        }
      }
      const result = this.materials.content(materialId);
      if (!result) return reply.code(404).send({ code: "material_not_found", message: "物料尚不可用。" });
      const range = String(request.headers.range ?? "");
      const match = /^bytes=(\d+)-(\d*)$/u.exec(range);
      if (match) {
        const start = Number(match[1]);
        const requestedEnd = match[2] ? Number(match[2]) : result.data.length - 1;
        const end = Math.min(requestedEnd, result.data.length - 1);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= result.data.length) {
          return reply.code(416).header("content-range", `bytes */${result.data.length}`).send();
        }
        return reply.code(206)
          .header("content-type", result.material.mimeType)
          .header("content-range", `bytes ${start}-${end}/${result.data.length}`)
          .header("content-length", String(end - start + 1))
          .header("accept-ranges", "bytes")
          .header("cache-control", "private, max-age=300")
          .header("x-content-type-options", "nosniff")
          .send(result.data.subarray(start, end + 1));
      }
      return reply
        .header("content-type", result.material.mimeType)
        .header("content-length", String(result.data.length))
        .header("accept-ranges", "bytes")
        .header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(result.material.name)}`)
        .header("cache-control", "private, max-age=300")
        .header("x-content-type-options", "nosniff")
        .send(result.data);
    });
    app.get("/api/local-bootstrap", async (request, reply) => {
      if (!isLoopbackAddress(request.ip)) return reply.code(403).send(loopbackOnly());
      try {
        const device = this.devices.localAdmin();
        return { deviceId: device.id, deviceKey: device.keyBase64 };
      } catch (error) {
        return sendApiError(reply, classifyLocalApiError(error, "bootstrap_unavailable", "本机管理设备初始化失败。"));
      }
    });
    app.get("/api/local/status", async (request, reply) => {
      if (!isLoopbackAddress(request.ip)) return reply.code(403).send(loopbackOnly());
      try {
        return {
          ready: true,
          cloud: this.cloud.enabled,
          pushNotifications: this.cloud.pushNotificationsAvailable,
          pairedDeviceCount: this.devicesList().filter((device) => !device.isLocalAdmin && !device.revokedAt).length,
          integrations: await inspectIntegrationStatuses(this.entrypoint),
        };
      } catch (error) {
        return sendApiError(reply, classifyLocalApiError(error, "status_unavailable", "本地状态检查失败。"));
      }
    });
    app.post("/api/local/integrations", async (request, reply) => {
      if (!isLoopbackAddress(request.ip)) return reply.code(403).send(loopbackOnly());
      const body = request.body as LocalIntegrationBody | null;
      try {
        if (body?.target === "all") {
          await installCodexPlugin(this.entrypoint);
          await installCliIntegrations(this.entrypoint);
        } else if (body?.target === "codex_gui") await installCodexPlugin(this.entrypoint);
        else if (body?.target === "cli") await installCliIntegrations(this.entrypoint);
        else {
          return sendApiError(reply, new ApiError("unknown_integration_target", "未知的集成目标。", 400, false, "target 仅支持 all、codex_gui、cli。"));
        }
        return { integrations: await inspectIntegrationStatuses(this.entrypoint) };
      } catch (error) {
        return sendApiError(reply, classifyIntegrationError(error));
      }
    });
    app.post("/api/local/pairing", async (request, reply) => {
      if (!isLoopbackAddress(request.ip)) return reply.code(403).send(loopbackOnly());
      try {
        return await this.createPairingPayload();
      } catch (error) {
        return sendApiError(reply, new ApiError(
          "pairing_create_failed",
          error instanceof Error ? error.message : String(error),
          503,
          true,
          "检查网络连接后重试。",
        ));
      }
    });
    app.post("/api/pair", async (request, reply) => {
      const body = request.body as PairBody | null;
      if (!body?.pairingId || !body.clientPublicKey || !body.proof) {
        return reply.code(400).send({ error: "Invalid pairing request" });
      }
      try {
        const result = this.devices.completePairing({
          pairingId: body.pairingId,
          clientPublicKey: body.clientPublicKey,
          proof: body.proof,
          ...(body.name ? { name: body.name } : {}),
        });
        if (!result) return reply.code(410).send({ error: "Pairing expired, used, or invalid" });
        const cloud = await this.cloud.provisionDevice(result.device.id);
        return {
          deviceId: result.device.id,
          serverProof: result.serverProof,
          ...(cloud ? { cloud } : {}),
        };
      } catch (error) {
        return sendApiError(reply, new ApiError(
          "pairing_complete_failed",
          "配对确认失败，请重新扫码。",
          500,
          true,
          "在管理页重新生成配对二维码后再试。",
        ));
      }
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
        onCommand: (authenticated, command) => {
          void this.handleCommand(authenticated, command).catch((error: unknown) => {
            console.error(`[zimlo:bridge] ${command.type} 处理失败:`, error);
            authenticated.send({
              type: "error",
              code: "command_failed",
              message: "操作未完成，请稍后重试。",
            });
          });
        },
      });
      socket.once("close", () => this.connections.delete(connection));
    });

    const publicRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../public");
    if (existsSync(publicRoot)) {
      // Keep a wildcard route so newly built, content-hashed assets are served
      // without requiring Fastify to have seen their filenames at startup.
      trace("register-static");
      await app.register(fastifyStatic, { root: publicRoot });
      app.setNotFoundHandler((request, reply) => {
        if (request.method === "GET") return reply.sendFile("index.html");
        return reply.code(404).send({ error: "Not found" });
      });
    }

    this.unsubscribe = this.runtime.onMessage((message) => this.broadcast(message));
    trace("listen");
    await app.listen({ port: this.options.port, host: this.options.lan ? "0.0.0.0" : "127.0.0.1" });
    trace("listening");
    // Resolve the port actually bound so tests and --port 0 callers get a
    // usable URL back instead of the configured value.
    const bound = app.server.address();
    const port = bound && typeof bound === "object" ? bound.port : this.options.port;
    const localUrl = `http://127.0.0.1:${port}`;
    const address = this.options.lan ? preferredLanAddress() : null;
    return { localUrl, lanUrl: address ? `http://${address}:${port}` : null, port };
  }

  async stop(): Promise<void> {
    for (const controller of this.pairingWatchers.values()) controller.abort();
    this.pairingWatchers.clear();
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
      case "device.revoke": {
        if (!connection.isLocalAdmin) return connection.send({ type: "error", code: "forbidden", message: "仅 Mac 本机管理页可撤销设备。" });
        const device = this.runtime.store.getDevice(command.deviceId);
        if (!device || device.isLocalAdmin) {
          return connection.send({ type: "error", code: "device_not_found", message: "这台设备不存在或不能撤销。" });
        }
        this.runtime.store.revokeDevice(command.deviceId);
        await this.cloud.revokeDevice(command.deviceId);
        for (const authenticated of this.connections) {
          if (authenticated.deviceId === command.deviceId) {
            authenticated.close(1008, "Device revoked");
          }
        }
        connection.send({ type: "devices.list", devices: this.devicesList() });
        return;
      }
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
          materialIds: command.materialIds ?? [],
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
          materialIds: command.materialIds ?? [],
          idempotencyKey: command.idempotencyKey,
        });
        return;
      }
      case "task.follow_up": {
        this.taskCommands.followUp({
          deviceId,
          sessionId: command.sessionId,
          text: command.text,
          materialIds: command.materialIds ?? [],
          idempotencyKey: command.idempotencyKey,
        });
        return;
      }
      case "material.register": {
        await this.materials.register(deviceId, command);
        return;
      }
      case "material.remote.request": {
        const published = await this.materials.publishRemoteCopy(deviceId, command.materialId);
        if (!published) {
          connection.send({ type: "error", code: "material_not_found", message: "这个物料已不存在，请刷新动态。" });
        }
        return;
      }
      case "task.command.retry": {
        const retried = this.taskCommands.retry(command.commandId);
        if (retried) connection.send({ type: "task.command.updated", command: retried });
        else connection.send({ type: "error", code: "task_command_not_found", message: "这条任务指令已不存在。" });
        return;
      }
      case "task.command.cancel": {
        const result = this.taskCommands.cancel({
          deviceId,
          ...(command.commandId !== undefined ? { commandId: command.commandId } : {}),
          ...(command.idempotencyKey !== undefined ? { idempotencyKey: command.idempotencyKey } : {}),
        });
        if (result.ok) {
          connection.send({ type: "task.command.updated", command: result.command });
          connection.send({
            type: "task.command.cancel.result",
            ...(command.commandId !== undefined ? { commandId: command.commandId } : {}),
            ...(command.idempotencyKey !== undefined ? { idempotencyKey: command.idempotencyKey } : {}),
            ok: true,
            message: "指令已撤回。",
          });
        }
        else if (result.code === "task_command_not_found") {
          // 原指令从未到达 Bridge 与已经被清理都满足“不会执行”，按幂等撤回成功处理。
          connection.send({
            type: "task.command.cancel.result",
            ...(command.commandId !== undefined ? { commandId: command.commandId } : {}),
            ...(command.idempotencyKey !== undefined ? { idempotencyKey: command.idempotencyKey } : {}),
            ok: true,
            message: "指令未执行，已从队列撤回。",
          });
        } else {
          if (result.command) connection.send({ type: "task.command.updated", command: result.command });
          connection.send({
            type: "task.command.cancel.result",
            ...(command.commandId !== undefined ? { commandId: command.commandId } : {}),
            ...(command.idempotencyKey !== undefined ? { idempotencyKey: command.idempotencyKey } : {}),
            ok: false,
            message: "指令已在执行或已结束，无法取消。",
          });
        }
        return;
      }
      case "feed.seen": {
        this.runtime.store.markFeedSeen(deviceId, command.postId);
        // A cached receipt can outlive its post. Acknowledge the no-op so the
        // client can retire that stale outbox entry instead of replaying it.
        connection.send({ type: "feed.seen.updated", postId: command.postId });
        return;
      }
      case "feed.dismiss": {
        this.runtime.store.dismissFeedItem(deviceId, command.itemId);
        connection.send({ type: "feed.dismissed.updated", itemId: command.itemId });
        return;
      }
      case "feed.dismiss.set": {
        const result = applyFeedDismissSet(this.runtime.store, deviceId, command.itemId, command.dismissed, command.idempotencyKey);
        if (result.dismissed) {
          // 与旧 feed.dismiss 相同的轻量确认；dismissed 是按设备存储的，
          // 只有发起方需要更新。
          connection.send({ type: "feed.dismissed.updated", itemId: command.itemId });
        } else {
          // 协议没有"取消移除"的增量消息，用设备作用域的快照让发起方
          // 拿到权威的 dismissedFeedItemIds。
          connection.send({ type: "session.snapshot", snapshot: this.runtime.snapshot(deviceId) });
        }
        return;
      }
      case "task.timeline.seen": {
        this.runtime.store.markTaskTimelineSeen(deviceId, command.sessionId, command.itemId);
        connection.send({ type: "task.timeline.seen.updated", sessionId: command.sessionId, itemId: command.itemId });
        return;
      }
      case "task.pin": {
        if (!this.runtime.store.getSession(command.sessionId)) return connection.send({ type: "error", code: "session_not_found", message: "这个任务已不存在。" });
        const result = setTaskPinnedIdempotent(this.runtime.store, deviceId, command.sessionId, command.pinned, command.idempotencyKey);
        connection.send({ type: "task.preference.updated", preference: result.preference });
        return;
      }
      case "task.archive": {
        if (!this.runtime.store.getSession(command.sessionId)) return connection.send({ type: "error", code: "session_not_found", message: "这个任务已不存在。" });
        const result = setTaskArchivedIdempotent(this.runtime.store, deviceId, command.sessionId, command.archived, command.idempotencyKey);
        connection.send({ type: "task.preference.updated", preference: result.preference });
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
            materialIds: [],
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
        const endpoint = command.token
          ? await this.cloud.registerPushDevice(
              deviceId,
              command.token,
              command.publicKey,
              command.environment ?? "production",
            )
          : command.endpoint ?? null;
        if (!endpoint) {
          return connection.send({
            type: "error",
            code: "notification_cloud_unavailable",
            message: "Cloudflare 通知服务尚未连接，设备 token 已保留在手机上并会在重连后重试。",
          });
        }
        const registration = this.runtime.store.upsertPushDevice(deviceId, endpoint, command.publicKey);
        this.runtime.store.saveIdempotentResult(`${deviceId}:${command.idempotencyKey}`, deviceId, { ok: true });
        connection.send({ type: "notification.device.updated", registration });
        return;
      }
      case "notification.device.unregister":
        await this.cloud.unregisterPushDevice(deviceId);
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
        try {
          connection.send({ type: "pairing.created", ...await this.createPairingPayload() });
        } catch (error) {
          connection.send({
            type: "error",
            code: "pairing_unavailable",
            message: error instanceof Error ? error.message : String(error),
          });
        }
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

  private async createPairingPayload(): Promise<{
    pairUrl: string;
    qrDataUrl: string;
    expiresAt: string;
    transport: PairingTransport;
    localPairUrl?: string;
  }> {
    const cloudReady = this.cloud.enabled && await this.cloud.ensureReady();
    const lanHost = preferredLanAddress();
    const endpoint = selectPairingEndpoint({
      cloudReady,
      cloudURL: this.cloud.relayURL,
      lanEnabled: this.options.lan,
      lanHost,
      port: this.options.port,
    });
    if (!endpoint) {
      throw new Error("云端暂时无法连接，请检查网络后重试。");
    }
    const result = this.devices.createPairing(endpoint.baseURL);
    const localPairUrl = endpoint.transport === "cloud" && this.options.lan && lanHost
      ? pairingURLForBase(result.pairUrl, `http://${lanHost}:${this.options.port}`)
      : null;
    if (endpoint.transport === "cloud") {
      const registered = await this.cloud.registerPairing(
        result.pairingId,
        result.relayToken,
        result.expiresAt,
      );
      if (!registered) throw new Error("云端配对暂时不可用，请稍后重试。");
      this.startCloudPairingWatcher(result);
    }
    return {
      pairUrl: result.pairUrl,
      qrDataUrl: await QRCode.toDataURL(result.pairUrl, { margin: 1, width: 320 }),
      expiresAt: result.expiresAt,
      transport: endpoint.transport,
      ...(localPairUrl ? { localPairUrl } : {}),
    };
  }

  private startCloudPairingWatcher(pairing: PairingResult): void {
    this.pairingWatchers.get(pairing.pairingId)?.abort();
    const controller = new AbortController();
    this.pairingWatchers.set(pairing.pairingId, controller);
    void this.watchCloudPairing(pairing, controller.signal)
      .finally(() => this.pairingWatchers.delete(pairing.pairingId));
  }

  private async watchCloudPairing(pairing: PairingResult, signal: AbortSignal): Promise<void> {
    const deadline = new Date(pairing.expiresAt).getTime();
    while (!signal.aborted && Date.now() < deadline) {
      try {
        const pending = await this.cloud.pendingPairingRequest(pairing.pairingId);
        if (!pending) {
          await this.waitForPairingPoll(signal);
          continue;
        }
        const result = this.devices.completePairing({
          pairingId: pairing.pairingId,
          clientPublicKey: pending.clientPublicKey,
          proof: pending.proof,
          ...(pending.name ? { name: pending.name } : {}),
        });
        if (!result) {
          await this.cloud.completePairing(
            pairing.pairingId,
            pending.requestId,
            { error: "Pairing expired, used, or invalid" },
            410,
          );
          return;
        }
        const cloud = await this.cloud.provisionDevice(result.device.id);
        await this.cloud.completePairing(pairing.pairingId, pending.requestId, {
          deviceId: result.device.id,
          serverProof: result.serverProof,
          ...(cloud ? { cloud } : {}),
        });
        return;
      } catch {
        await this.waitForPairingPoll(signal);
      }
    }
  }

  private async waitForPairingPoll(signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 500);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
