import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";

const INFO_PAIR = utf8ToBytes("zimlo-pair-v1");
const INFO_DEVICE = utf8ToBytes("zimlo-device-v1");
const INFO_CLIENT_TX = utf8ToBytes("zimlo-ws-client-tx-v1");
const INFO_SERVER_TX = utf8ToBytes("zimlo-ws-server-tx-v1");

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function createKeyPair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const privateKey = x25519.utils.randomSecretKey();
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

export function derivePairKey(
  privateKey: Uint8Array,
  peerPublicKey: Uint8Array,
  secret: Uint8Array,
): Uint8Array {
  return hkdf(sha256, x25519.getSharedSecret(privateKey, peerPublicKey), secret, INFO_PAIR, 32);
}

export function deriveDeviceKey(pairKey: Uint8Array, secret: Uint8Array): Uint8Array {
  return hkdf(sha256, pairKey, secret, INFO_DEVICE, 32);
}

export function makeProof(key: Uint8Array, message: string): string {
  return toBase64Url(hmac(sha256, key, utf8ToBytes(message)));
}

export function verifyProof(key: Uint8Array, message: string, proof: string): boolean {
  const actual = makeProof(key, message);
  if (actual.length !== proof.length) return false;
  let mismatch = 0;
  for (let index = 0; index < actual.length; index += 1) {
    mismatch |= actual.charCodeAt(index) ^ proof.charCodeAt(index);
  }
  return mismatch === 0;
}

export function deriveConnectionKeys(
  deviceKey: Uint8Array,
  clientNonce: Uint8Array,
  serverNonce: Uint8Array,
): { clientTx: Uint8Array; serverTx: Uint8Array } {
  const salt = concatBytes(clientNonce, serverNonce);
  return {
    clientTx: hkdf(sha256, deviceKey, salt, INFO_CLIENT_TX, 32),
    serverTx: hkdf(sha256, deviceKey, salt, INFO_SERVER_TX, 32),
  };
}

function counterNonce(counter: number): Uint8Array {
  const nonce = new Uint8Array(24);
  const view = new DataView(nonce.buffer);
  view.setBigUint64(16, BigInt(counter), false);
  return nonce;
}

export function encryptFrame(key: Uint8Array, counter: number, value: unknown, aad: string): string {
  const plaintext = utf8ToBytes(JSON.stringify(value));
  return toBase64Url(xchacha20poly1305(key, counterNonce(counter), utf8ToBytes(aad)).encrypt(plaintext));
}

export function decryptFrame<T>(key: Uint8Array, counter: number, ciphertext: string, aad: string): T {
  const plaintext = xchacha20poly1305(key, counterNonce(counter), utf8ToBytes(aad)).decrypt(
    fromBase64Url(ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

export { bytesToHex, concatBytes, hexToBytes, randomBytes };
