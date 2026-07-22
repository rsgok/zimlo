import {
  createKeyPair,
  deriveDeviceKey,
  derivePairKey,
  fromBase64Url,
  makeProof,
  randomBytes,
  toBase64Url,
  verifyProof,
} from "@zimlo/protocol/crypto";
import { uuidV7 } from "@zimlo/adapters";
import { ZimloStore, type DeviceRecord } from "./store.js";

interface PairingRecord {
  id: string;
  secret: Uint8Array;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  expiresAt: number;
  used: boolean;
}

export interface PairingResult {
  pairingId: string;
  pairUrl: string;
  expiresAt: string;
}

export class DeviceManager {
  private readonly store: ZimloStore;
  private readonly pairings = new Map<string, PairingRecord>();

  constructor(store: ZimloStore) {
    this.store = store;
  }

  localAdmin(): DeviceRecord {
    const existing = this.store.listDevices().find((device) => device.isLocalAdmin && !device.revokedAt);
    if (existing) return existing;
    const now = new Date().toISOString();
    return this.store.upsertDevice({
      id: `local_${uuidV7()}`,
      name: "Local Mac browser",
      keyBase64: toBase64Url(randomBytes(32)),
      createdAt: now,
      lastSeenAt: now,
      revokedAt: null,
      isLocalAdmin: true,
      canApprove: true,
    });
  }

  createPairing(baseUrl: string): PairingResult {
    this.prunePairings();
    const pair = createKeyPair();
    const id = uuidV7();
    const expiresAt = Date.now() + 120_000;
    const pairing: PairingRecord = {
      id,
      secret: randomBytes(32),
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      expiresAt,
      used: false,
    };
    this.pairings.set(id, pairing);
    const fragment = new URLSearchParams({
      pairingId: id,
      secret: toBase64Url(pairing.secret),
      bridgeKey: toBase64Url(pairing.publicKey),
    });
    return {
      pairingId: id,
      pairUrl: `${baseUrl}/#${fragment.toString()}`,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  completePairing(input: {
    pairingId: string;
    clientPublicKey: string;
    proof: string;
    name?: string;
  }): { device: DeviceRecord; serverProof: string } | null {
    const pairing = this.pairings.get(input.pairingId);
    if (!pairing || pairing.used || pairing.expiresAt <= Date.now()) return null;
    const clientPublic = fromBase64Url(input.clientPublicKey);
    const pairKey = derivePairKey(pairing.privateKey, clientPublic, pairing.secret);
    if (!verifyProof(pairKey, `client:${pairing.id}`, input.proof)) return null;
    pairing.used = true;
    const key = deriveDeviceKey(pairKey, pairing.secret);
    const now = new Date().toISOString();
    const device = this.store.upsertDevice({
      id: `device_${uuidV7()}`,
      name: input.name?.slice(0, 80) || "Paired browser",
      keyBase64: toBase64Url(key),
      createdAt: now,
      lastSeenAt: now,
      revokedAt: null,
      isLocalAdmin: false,
      canApprove: false,
    });
    this.pairings.delete(pairing.id);
    return { device, serverProof: makeProof(pairKey, `server:${device.id}`) };
  }

  authenticate(deviceId: string, clientNonce: string, proof: string): DeviceRecord | null {
    const device = this.store.getDevice(deviceId);
    if (!device || device.revokedAt) return null;
    const key = fromBase64Url(device.keyBase64);
    if (!verifyProof(key, `ws:${clientNonce}`, proof)) return null;
    return this.store.upsertDevice({ ...device, lastSeenAt: new Date().toISOString() });
  }

  private prunePairings(): void {
    for (const [id, pairing] of this.pairings) {
      if (pairing.used || pairing.expiresAt <= Date.now()) this.pairings.delete(id);
    }
  }
}
