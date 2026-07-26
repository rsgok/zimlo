import { describe, expect, it } from "vitest";
import {
  createKeyPair,
  decryptFrame,
  deriveConnectionKeys,
  deriveDeviceKey,
  derivePairKey,
  encryptFrame,
  makeProof,
  openPushRoute,
  randomBytes,
  sealPushRoute,
  verifyProof,
} from "../src/crypto.js";

describe("pairing and encrypted frames", () => {
  it("derives the same one-time pair/device key on both peers", () => {
    const bridge = createKeyPair();
    const browser = createKeyPair();
    const secret = randomBytes(32);
    const bridgePair = derivePairKey(bridge.privateKey, browser.publicKey, secret);
    const browserPair = derivePairKey(browser.privateKey, bridge.publicKey, secret);
    expect([...bridgePair]).toEqual([...browserPair]);
    expect(verifyProof(bridgePair, "client:pair", makeProof(browserPair, "client:pair"))).toBe(true);
    expect([...deriveDeviceKey(bridgePair, secret)]).toEqual([...deriveDeviceKey(browserPair, secret)]);
  });

  it("encrypts by direction and rejects the wrong counter", () => {
    const deviceKey = randomBytes(32);
    const keys = deriveConnectionKeys(deviceKey, randomBytes(24), randomBytes(24));
    const ciphertext = encryptFrame(keys.clientTx, 0, { type: "snapshot.request" }, "device-a");
    expect(decryptFrame(keys.clientTx, 0, ciphertext, "device-a")).toEqual({ type: "snapshot.request" });
    expect(() => decryptFrame(keys.clientTx, 1, ciphertext, "device-a")).toThrow();
    expect(() => decryptFrame(keys.serverTx, 0, ciphertext, "device-a")).toThrow();
  });

  it("seals push routes so only the registered device can read them", () => {
    const device = createKeyPair();
    const other = createKeyPair();
    const envelope = sealPushRoute(device.publicKey, { sessionId: "session-a" });
    expect(openPushRoute(device.privateKey, envelope)).toEqual({ sessionId: "session-a" });
    expect(() => openPushRoute(other.privateKey, envelope)).toThrow();
    expect(JSON.stringify(envelope)).not.toContain("session-a");
  });
});
