import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createKeyPair,
  decryptFrame,
  deriveConnectionKeys,
  deriveDeviceKey,
  derivePairKey,
  encryptFrame,
  fromBase64Url,
  makeProof,
  openPushRoute,
  randomBytes,
  sealPushRoute,
  verifyProof,
  type PushRouteEnvelope,
} from "../src/crypto.js";

describe("pairing and encrypted frames", () => {
  it("keeps the checked-in Rust migration vectors byte-compatible", () => {
    const vector = JSON.parse(readFileSync(new URL("../test-vectors/crypto.json", import.meta.url), "utf8")) as {
      version: number;
      pair: Record<string, string>;
      frame: Record<string, unknown> & { value: unknown };
      pushRoute: { privateKey: string; envelope: PushRouteEnvelope; value: unknown };
    };
    expect(vector.version).toBe(1);
    const pairKey = derivePairKey(
      fromBase64Url(vector.pair.bridgePrivateKey!),
      fromBase64Url(vector.pair.clientPublicKey!),
      fromBase64Url(vector.pair.secret!),
    );
    expect([...pairKey]).toEqual([...fromBase64Url(vector.pair.pairKey!)]);
    expect([...deriveDeviceKey(pairKey, fromBase64Url(vector.pair.secret!))])
      .toEqual([...fromBase64Url(vector.pair.deviceKey!)]);
    expect(makeProof(pairKey, vector.pair.proofMessage!)).toBe(vector.pair.proof);

    const keys = deriveConnectionKeys(
      fromBase64Url(vector.frame.deviceKey as string),
      fromBase64Url(vector.frame.clientNonce as string),
      fromBase64Url(vector.frame.serverNonce as string),
    );
    expect([...keys.clientTx]).toEqual([...fromBase64Url(vector.frame.clientTxKey as string)]);
    expect([...keys.serverTx]).toEqual([...fromBase64Url(vector.frame.serverTxKey as string)]);
    expect(encryptFrame(
      keys.clientTx,
      vector.frame.counter as number,
      vector.frame.value,
      vector.frame.aad as string,
    )).toBe(vector.frame.ciphertext);
    expect(openPushRoute(
      fromBase64Url(vector.pushRoute.privateKey),
      vector.pushRoute.envelope,
    )).toEqual(vector.pushRoute.value);
  });

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
