import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { toBase64Url } from "@zimlo/protocol/crypto";
import type { PushRouteEnvelope } from "@zimlo/protocol/crypto";
import type { ZimloStore } from "./store.js";

interface CloudIdentity {
  installationId: string;
  publicKey: string;
  privateKeyPEM: string;
}

interface DeviceCloudCredentials {
  relayURL: string;
  accessToken: string;
}

interface PushInput {
  deviceId: string;
  kind: "approval" | "failure" | "review";
  collapseId: string;
  alert: { title: string; body: string };
  route: PushRouteEnvelope;
}

const IDENTITY_METADATA_KEY = "cloud_installation_identity_v1";
const DEFAULT_CLOUD_URL = "https://zimlo-cloud.zimlo.workers.dev";

function sha256URL(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export class CloudService {
  private readonly store: ZimloStore;
  private readonly baseURL: string | null;
  private identity: CloudIdentity | null = null;
  private readyPromise: Promise<boolean> | null = null;

  constructor(store: ZimloStore) {
    this.store = store;
    const configuredURL = process.env.ZIMLO_CLOUD_URL?.trim();
    this.baseURL = process.env.ZIMLO_CLOUD_DISABLED === "1"
      ? null
      : (configuredURL || DEFAULT_CLOUD_URL).replace(/\/+$/u, "");
  }

  get enabled(): boolean {
    return this.baseURL !== null;
  }

  get relayURL(): string | null {
    return this.baseURL;
  }

  async ensureReady(): Promise<boolean> {
    if (!this.baseURL) return false;
    this.readyPromise ??= this.registerInstallation().catch(() => false);
    const ready = await this.readyPromise;
    if (!ready) this.readyPromise = null;
    return ready;
  }

  async provisionDevice(deviceId: string): Promise<DeviceCloudCredentials | null> {
    if (!await this.ensureReady() || !this.baseURL) return null;
    const accessToken = toBase64Url(randomBytes(32));
    this.store.setMetadata(`cloud_device_token:${deviceId}`, accessToken);
    const response = await this.signedFetch("/v1/devices", "POST", {
      deviceId,
      accessTokenHash: sha256URL(accessToken),
    });
    if (!response.ok) {
      this.store.deleteMetadata(`cloud_device_token:${deviceId}`);
      return null;
    }
    return { relayURL: this.baseURL, accessToken };
  }

  async registerPushDevice(deviceId: string, apnsToken: string, routePublicKey: string): Promise<string | null> {
    if (!await this.ensureReady()) return null;
    const accessToken = this.store.getMetadata(`cloud_device_token:${deviceId}`);
    if (!accessToken) return null;
    const response = await this.signedFetch("/v1/devices", "POST", {
      deviceId,
      accessTokenHash: sha256URL(accessToken),
      apnsToken,
      routePublicKey,
    });
    if (!response.ok) return null;
    const result = await response.json() as { endpoint?: string };
    return result.endpoint ?? null;
  }

  async sendPush(input: PushInput): Promise<number> {
    if (!await this.ensureReady()) return 503;
    const response = await this.signedFetch("/v1/push", "POST", input);
    return response.status;
  }

  async unregisterPushDevice(deviceId: string): Promise<void> {
    try {
      if (!await this.ensureReady()) return;
      await this.signedFetch(`/v1/devices/${encodeURIComponent(deviceId)}/push`, "DELETE", {});
    } catch {
      // Local notification state still wins. A later APNs registration
      // replaces the old token if this best-effort cleanup was unavailable.
    }
  }

  async revokeDevice(deviceId: string): Promise<void> {
    try {
      if (!await this.ensureReady()) return;
      const response = await this.signedFetch(`/v1/devices/${encodeURIComponent(deviceId)}`, "DELETE", {});
      if (response.ok) this.store.deleteMetadata(`cloud_device_token:${deviceId}`);
    } catch {
      // The local Bridge identity is already revoked. Keep the cloud token
      // locally so a later cleanup can retry rather than losing its handle.
    }
  }

  async macSocketHeaders(): Promise<Record<string, string> | null> {
    if (!await this.ensureReady() || !this.identity) return null;
    return this.signedHeaders("GET", "/v1/sync/mac", "");
  }

  private async registerInstallation(): Promise<boolean> {
    if (!this.baseURL) return false;
    this.identity = this.loadOrCreateIdentity();
    const timestamp = new Date().toISOString();
    const message = `${timestamp}.POST./v1/installations.${this.identity.installationId}.${this.identity.publicKey}`;
    const signature = this.sign(message);
    const response = await fetch(`${this.baseURL}/v1/installations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(5_000),
      body: JSON.stringify({
        installationId: this.identity.installationId,
        publicKey: this.identity.publicKey,
        timestamp,
        signature,
      }),
    });
    if (!response.ok) return false;
    await this.cleanupRevokedDevices();
    return true;
  }

  private async cleanupRevokedDevices(): Promise<void> {
    for (const device of this.store.listDevices()) {
      if (!device.revokedAt || !this.store.getMetadata(`cloud_device_token:${device.id}`)) continue;
      try {
        const response = await this.signedFetch(`/v1/devices/${encodeURIComponent(device.id)}`, "DELETE", {});
        if (response.ok) this.store.deleteMetadata(`cloud_device_token:${device.id}`);
      } catch {
        // Retain the token marker and retry after the next cloud registration.
      }
    }
  }

  private loadOrCreateIdentity(): CloudIdentity {
    const existing = this.store.getMetadata(IDENTITY_METADATA_KEY);
    if (existing) {
      try {
        const parsed = JSON.parse(existing) as CloudIdentity;
        if (parsed.installationId && parsed.publicKey && parsed.privateKeyPEM) return parsed;
      } catch {
        // Corrupt cloud identity is replaced locally; the old installation
        // remains unreachable because its private key is gone.
      }
    }
    const pair = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      publicKeyEncoding: { type: "spki", format: "der" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const identity: CloudIdentity = {
      installationId: `installation_${randomUUID().replaceAll("-", "")}`,
      publicKey: pair.publicKey.toString("base64url"),
      privateKeyPEM: pair.privateKey,
    };
    this.store.setMetadata(IDENTITY_METADATA_KEY, JSON.stringify(identity));
    return identity;
  }

  private async signedFetch(pathname: string, method: string, value: unknown): Promise<Response> {
    if (!this.baseURL) throw new Error("ZIMLO_CLOUD_URL is not configured");
    const body = JSON.stringify(value);
    return fetch(`${this.baseURL}${pathname}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...this.signedHeaders(method, pathname, body),
      },
      signal: AbortSignal.timeout(5_000),
      body,
    });
  }

  private signedHeaders(method: string, pathname: string, body: string): Record<string, string> {
    if (!this.identity) throw new Error("Cloud identity is unavailable");
    const timestamp = new Date().toISOString();
    const bodyHash = sha256URL(body);
    const message = `${timestamp}.${method.toUpperCase()}.${pathname}.${bodyHash}`;
    return {
      "x-zimlo-installation": this.identity.installationId,
      "x-zimlo-timestamp": timestamp,
      "x-zimlo-signature": this.sign(message),
    };
  }

  private sign(message: string): string {
    if (!this.identity) throw new Error("Cloud identity is unavailable");
    return sign("sha256", Buffer.from(message), {
      key: createPrivateKey(this.identity.privateKeyPEM),
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
  }
}
