import WebSocket, { type RawData } from "ws";
import type { CloudService } from "./cloud-service.js";

interface RelayFrame {
  type: "open" | "data" | "close";
  connectionId: string;
  data?: string;
}

interface LocalConnection {
  socket: WebSocket;
  pending: string[];
}

export class CloudRelayClient {
  private readonly cloud: CloudService;
  private readonly localPort: number;
  private readonly locals = new Map<string, LocalConnection>();
  private relay: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private retryMs = 1_000;

  constructor(cloud: CloudService, localPort: number) {
    this.cloud = cloud;
    this.localPort = localPort;
  }

  async start(): Promise<boolean> {
    this.stopped = false;
    if (!this.cloud.enabled) return false;
    await this.connect();
    return true;
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.relay?.close(1000, "Zimlo stopping");
    this.relay = null;
    for (const local of this.locals.values()) local.socket.close();
    this.locals.clear();
  }

  private async connect(): Promise<void> {
    const baseURL = this.cloud.relayURL;
    const headers = await this.cloud.macSocketHeaders();
    if (!baseURL || !headers || this.stopped) return this.scheduleReconnect();
    const url = new URL("/v1/sync/mac", baseURL);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const relay = new WebSocket(url, { headers });
    this.relay = relay;
    relay.on("open", () => {
      this.retryMs = 1_000;
    });
    relay.on("message", (data) => this.onRelayMessage(data));
    relay.on("close", () => {
      if (this.relay === relay) this.relay = null;
      for (const local of this.locals.values()) local.socket.close();
      this.locals.clear();
      this.scheduleReconnect();
    });
    relay.on("error", () => undefined);
  }

  private onRelayMessage(data: RawData): void {
    let frame: RelayFrame;
    try {
      frame = JSON.parse(data.toString()) as RelayFrame;
    } catch {
      return this.relay?.close(1003, "Invalid cloud relay frame");
    }
    if (!frame.connectionId) return;
    if (frame.type === "open") {
      this.openLocal(frame.connectionId);
      return;
    }
    if (frame.type === "close") {
      this.closeLocal(frame.connectionId);
      return;
    }
    if (frame.type !== "data" || typeof frame.data !== "string") return;
    const local = this.locals.get(frame.connectionId) ?? this.openLocal(frame.connectionId);
    if (local.socket.readyState === WebSocket.OPEN) local.socket.send(frame.data);
    else local.pending.push(frame.data);
  }

  private openLocal(connectionId: string): LocalConnection {
    const existing = this.locals.get(connectionId);
    if (existing) return existing;
    const socket = new WebSocket(`ws://127.0.0.1:${this.localPort}/ws`);
    const local: LocalConnection = { socket, pending: [] };
    this.locals.set(connectionId, local);
    socket.on("open", () => {
      for (const value of local.pending.splice(0)) socket.send(value);
    });
    socket.on("message", (data) => {
      if (this.relay?.readyState !== WebSocket.OPEN) return;
      this.relay.send(JSON.stringify({ type: "data", connectionId, data: data.toString() }));
    });
    socket.on("close", () => {
      if (this.locals.get(connectionId) !== local) return;
      this.locals.delete(connectionId);
      if (this.relay?.readyState === WebSocket.OPEN) {
        this.relay.send(JSON.stringify({ type: "close", connectionId }));
      }
    });
    socket.on("error", () => undefined);
    return local;
  }

  private closeLocal(connectionId: string): void {
    const local = this.locals.get(connectionId);
    if (!local) return;
    this.locals.delete(connectionId);
    local.socket.close();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const wait = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, wait);
    this.reconnectTimer.unref();
  }
}
