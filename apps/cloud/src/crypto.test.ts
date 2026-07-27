import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  base64URL,
  createAPNsJWT,
  freshTimestamp,
  installationRegistrationMessage,
  signedRequestMessage,
  verifyInstallationSignature,
} from "./crypto.js";

describe("cloud request authentication", () => {
  it("verifies the Mac installation proof using P-256 P1363 signatures", async () => {
    const keys = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      publicKeyEncoding: { type: "spki", format: "der" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const timestamp = "2026-07-27T08:00:00.000Z";
    const message = installationRegistrationMessage(
      timestamp,
      "installation_0123456789abcdef",
      keys.publicKey.toString("base64url"),
    );
    const signature = sign("sha256", Buffer.from(message), {
      key: keys.privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");

    await expect(verifyInstallationSignature(
      keys.publicKey.toString("base64url"),
      message,
      signature,
    )).resolves.toBe(true);
    await expect(verifyInstallationSignature(
      keys.publicKey.toString("base64url"),
      `${message}.tampered`,
      signature,
    )).resolves.toBe(false);
  });

  it("binds a signed request to method, path, and body", async () => {
    const first = await signedRequestMessage(
      "2026-07-27T08:00:00.000Z",
      "post",
      "/v1/devices",
      "{\"deviceId\":\"one\"}",
    );
    const second = await signedRequestMessage(
      "2026-07-27T08:00:00.000Z",
      "post",
      "/v1/devices",
      "{\"deviceId\":\"two\"}",
    );
    expect(first).not.toBe(second);
    expect(first).toContain(".POST./v1/devices.");
  });

  it("rejects stale timestamps", () => {
    const now = Date.parse("2026-07-27T08:10:00.000Z");
    expect(freshTimestamp("2026-07-27T08:06:00.000Z", now)).toBe(true);
    expect(freshTimestamp("2026-07-27T08:04:59.000Z", now)).toBe(false);
  });
});

describe("APNs provider token", () => {
  it("creates an ES256 JWT without exposing the private key", async () => {
    const keys = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const token = await createAPNsJWT({
      privateKeyPEM: keys.privateKey,
      keyId: "KEY123",
      teamId: "TEAM123",
      issuedAt: 1_700_000_000,
    });
    const [header, claims, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEY123" });
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toEqual({ iss: "TEAM123", iat: 1_700_000_000 });
    expect(Buffer.from(signature!, "base64url")).toHaveLength(64);
    expect(token).not.toContain(keys.privateKey);
    expect(base64URL(new Uint8Array([251, 255]))).toBe("-_8");
  });
});
