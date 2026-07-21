import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import QRCode from "qrcode";
import type { ClientCommand, ServerMessage } from "@zimlo/protocol";
import { ActionBroker } from "./action-broker.js";
import { DeviceManager } from "./device-manager.js";
import { isLoopbackAddress, isTrustedLanAddress, preferredLanAddress } from "./network.js";
import { ResumeService } from "./resume-service.js";
import { RuntimeHub } from "./runtime.js";
import { SecureSocket } from "./secure-socket.js";

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
  private readonly resume: ResumeService;
  private readonly options: BridgeOptions;
  private readonly connections = new Set<SecureSocket>();
  private readonly messageRuns = new Map<string, Promise<{ ok: boolean; message: string }>>();
  private app: FastifyInstance | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(input: {
    runtime: RuntimeHub;
    broker: ActionBroker;
    devices: DeviceManager;
    resume: ResumeService;
    options: BridgeOptions;
  }) {
    this.runtime = input.runtime;
    this.broker = input.broker;
    this.devices = input.devices;
    this.resume = input.resume;
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

    app.get("/healthz", async () => ({ ok: true, version: "0.1.0" }));
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
          authenticated.send({ type: "session.snapshot", snapshot: this.runtime.snapshot() });
        },
        onCommand: (authenticated, command) => void this.handleCommand(authenticated, command),
      });
      socket.once("close", () => this.connections.delete(connection));
    });

    const publicRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../public");
    if (existsSync(publicRoot)) {
      await app.register(fastifyStatic, { root: publicRoot, wildcard: false });
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
        connection.send({ type: "session.snapshot", snapshot: this.runtime.snapshot() });
        return;
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
      case "action.decide": {
        if (!connection.isLocalAdmin && !this.runtime.lanApprovalsEnabled) {
          return connection.send({ type: "action.result", actionId: command.actionId, ok: false, message: "本次运行尚未在 Mac 上开启 LAN 审批。" });
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
        const key = `${deviceId}:${command.idempotencyKey}`;
        const prior = this.runtime.store.getIdempotentResult(key);
        if (prior && typeof prior === "object") {
          const result = prior as { ok: boolean; message: string };
          return connection.send({ type: "session.message.result", sessionId: command.sessionId, ...result });
        }
        let run = this.messageRuns.get(key);
        if (!run) {
          run = this.resume.sendMessage(command.sessionId, command.text);
          this.messageRuns.set(key, run);
        }
        const result = await run;
        this.messageRuns.delete(key);
        this.runtime.store.saveIdempotentResult(key, `message:${command.sessionId}`, result);
        connection.send({ type: "session.message.result", sessionId: command.sessionId, ...result });
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
    }
  }

  private devicesList() {
    return this.runtime.store.listDevices().map(({ keyBase64: _keyBase64, ...device }) => device);
  }
}
