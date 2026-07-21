import type { RawData, WebSocket } from "ws";
import {
  decryptFrame,
  deriveConnectionKeys,
  encryptFrame,
  fromBase64Url,
  makeProof,
  randomBytes,
  toBase64Url,
} from "@zimlo/protocol/crypto";
import type { ClientCommand, ServerMessage } from "@zimlo/protocol";
import { ClientCommandSchema } from "@zimlo/protocol";
import { DeviceManager } from "./device-manager.js";
import type { DeviceRecord } from "./store.js";

interface AuthMessage {
  type: "auth";
  deviceId: string;
  clientNonce: string;
  proof: string;
}

interface SecureFrame {
  type: "secure";
  counter: number;
  ciphertext: string;
}

function parseObject(data: RawData): Record<string, unknown> | null {
  try {
    const value = JSON.parse(data.toString()) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export class SecureSocket {
  private readonly socket: WebSocket;
  private readonly devices: DeviceManager;
  private readonly onAuthenticated: (connection: SecureSocket) => void;
  private readonly onCommand: (connection: SecureSocket, command: ClientCommand) => void;
  private device: DeviceRecord | null = null;
  private clientTxKey: Uint8Array | null = null;
  private serverTxKey: Uint8Array | null = null;
  private receiveCounter = 0;
  private sendCounter = 0;

  constructor(input: {
    socket: WebSocket;
    devices: DeviceManager;
    onAuthenticated: (connection: SecureSocket) => void;
    onCommand: (connection: SecureSocket, command: ClientCommand) => void;
  }) {
    this.socket = input.socket;
    this.devices = input.devices;
    this.onAuthenticated = input.onAuthenticated;
    this.onCommand = input.onCommand;
    this.socket.on("message", (data) => this.receive(data));
  }

  get deviceId(): string | null {
    return this.device?.id ?? null;
  }

  get isLocalAdmin(): boolean {
    return this.device?.isLocalAdmin ?? false;
  }

  send(message: ServerMessage): void {
    if (!this.device || !this.serverTxKey || this.socket.readyState !== this.socket.OPEN) return;
    const counter = this.sendCounter;
    this.sendCounter += 1;
    this.socket.send(JSON.stringify({
      type: "secure",
      counter,
      ciphertext: encryptFrame(this.serverTxKey, counter, message, this.aad()),
    } satisfies SecureFrame));
  }

  close(code = 1000, reason = "Bridge stopped"): void {
    this.socket.close(code, reason);
  }

  private receive(data: RawData): void {
    const value = parseObject(data);
    if (!value) return this.close(1003, "Invalid JSON");
    if (!this.device) {
      this.authenticate(value);
      return;
    }
    if (value.type !== "secure" || typeof value.counter !== "number" || typeof value.ciphertext !== "string") {
      return this.close(1008, "Encrypted frame required");
    }
    if (!Number.isSafeInteger(value.counter) || value.counter !== this.receiveCounter || !this.clientTxKey) {
      return this.close(1008, "Replay or counter gap");
    }
    try {
      const command = decryptFrame<unknown>(this.clientTxKey, value.counter, value.ciphertext, this.aad());
      const parsed = ClientCommandSchema.safeParse(command);
      if (!parsed.success) {
        this.send({ type: "error", code: "invalid_command", message: "消息格式不受支持。" });
        return;
      }
      this.receiveCounter += 1;
      this.onCommand(this, parsed.data);
    } catch {
      this.close(1008, "Unable to decrypt frame");
    }
  }

  private authenticate(value: Record<string, unknown>): void {
    if (
      value.type !== "auth"
      || typeof value.deviceId !== "string"
      || typeof value.clientNonce !== "string"
      || typeof value.proof !== "string"
    ) {
      return this.close(1008, "Authentication required");
    }
    const auth = value as unknown as AuthMessage;
    const device = this.devices.authenticate(auth.deviceId, auth.clientNonce, auth.proof);
    if (!device) return this.close(1008, "Authentication failed");
    try {
      const clientNonce = fromBase64Url(auth.clientNonce);
      if (clientNonce.length !== 24) return this.close(1008, "Invalid nonce");
      const serverNonce = randomBytes(24);
      const deviceKey = fromBase64Url(device.keyBase64);
      const keys = deriveConnectionKeys(deviceKey, clientNonce, serverNonce);
      this.device = device;
      this.clientTxKey = keys.clientTx;
      this.serverTxKey = keys.serverTx;
      const serverNonceText = toBase64Url(serverNonce);
      this.socket.send(JSON.stringify({
        type: "auth.ok",
        serverNonce: serverNonceText,
        proof: makeProof(deviceKey, `ws-server:${auth.clientNonce}:${serverNonceText}`),
      }));
      this.onAuthenticated(this);
    } catch {
      this.close(1008, "Authentication failed");
    }
  }

  private aad(): string {
    return `zimlo-ws-v1:${this.device?.id ?? "unknown"}`;
  }
}
