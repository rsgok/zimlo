import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createKeyPair,
  derivePairKey,
  fromBase64Url,
  makeProof,
  toBase64Url,
} from "@zimlo/protocol/crypto";
import { DeviceManager } from "../src/device-manager.js";
import { ZimloStore } from "../src/store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("DeviceManager cloud pairing", () => {
  it("adds a separate relay token without exposing it to the device key derivation", () => {
    const root = mkdtempSync(join(tmpdir(), "zimlo-device-manager-"));
    roots.push(root);
    const store = new ZimloStore(join(root, "zimlo.db"));
    const devices = new DeviceManager(store);
    const pairing = devices.createPairing("https://cloud.example");
    const fragment = new URLSearchParams(new URL(pairing.pairUrl).hash.slice(1));

    expect(fragment.get("pairingToken")).toBe(pairing.relayToken);
    expect(pairing.relayToken).not.toBe(fragment.get("secret"));

    const client = createKeyPair();
    const secret = fromBase64Url(fragment.get("secret")!);
    const pairKey = derivePairKey(
      client.privateKey,
      fromBase64Url(fragment.get("bridgeKey")!),
      secret,
    );
    const result = devices.completePairing({
      pairingId: pairing.pairingId,
      clientPublicKey: toBase64Url(client.publicKey),
      proof: makeProof(pairKey, `client:${pairing.pairingId}`),
      name: "iPhone",
    });
    expect(result?.device.name).toBe("iPhone");
    expect(result?.device.canApprove).toBe(true);
    expect(result?.device.canManageTrust).toBe(true);
    expect(result?.serverProof).toBeTruthy();
    store.close();
  });

  it("invalidates a generated pairing when it is cancelled", () => {
    const root = mkdtempSync(join(tmpdir(), "zimlo-device-manager-"));
    roots.push(root);
    const store = new ZimloStore(join(root, "zimlo.db"));
    const devices = new DeviceManager(store);
    const pairing = devices.createPairing("https://cloud.example");
    const fragment = new URLSearchParams(new URL(pairing.pairUrl).hash.slice(1));
    const client = createKeyPair();
    const secret = fromBase64Url(fragment.get("secret")!);
    const pairKey = derivePairKey(client.privateKey, fromBase64Url(fragment.get("bridgeKey")!), secret);

    expect(devices.cancelPairing(pairing.pairingId)).toBe(true);
    expect(devices.cancelPairing(pairing.pairingId)).toBe(false);
    expect(devices.completePairing({
      pairingId: pairing.pairingId,
      clientPublicKey: toBase64Url(client.publicKey),
      proof: makeProof(pairKey, `client:${pairing.pairingId}`),
    })).toBeNull();
    store.close();
  });

  it("migrates existing active phones to the new permission defaults only once", () => {
    const root = mkdtempSync(join(tmpdir(), "zimlo-device-manager-"));
    roots.push(root);
    const path = join(root, "zimlo.db");
    const seed = new ZimloStore(path);
    const now = new Date().toISOString();
    seed.upsertDevice({ id: "phone", name: "Existing iPhone", keyBase64: "key", createdAt: now, lastSeenAt: now, revokedAt: null, isLocalAdmin: false, canApprove: false, canManageTrust: false });
    seed.database.prepare("DELETE FROM metadata WHERE key = 'device_permissions_default_on_v1'").run();
    seed.close();

    const migrated = new ZimloStore(path);
    expect(migrated.getDevice("phone")).toEqual(expect.objectContaining({ canApprove: true, canManageTrust: true }));
    migrated.setDeviceApproval("phone", false);
    migrated.setDeviceTrustManagement("phone", false);
    migrated.close();

    const reopened = new ZimloStore(path);
    expect(reopened.getDevice("phone")).toEqual(expect.objectContaining({ canApprove: false, canManageTrust: false }));
    reopened.close();
  });
});
