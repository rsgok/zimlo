const encoder = new TextEncoder();

export function base64URL(bytes: ArrayBuffer | Uint8Array): string {
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function fromBase64URL(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function exactBuffer(value: Uint8Array): ArrayBuffer {
  return new Uint8Array(value).buffer;
}

export async function sha256Text(value: string): Promise<string> {
  return base64URL(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

export async function sha256Bytes(value: ArrayBuffer): Promise<string> {
  return base64URL(await crypto.subtle.digest("SHA-256", value));
}

async function importInstallationKey(publicKeySPKI: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "spki",
    exactBuffer(fromBase64URL(publicKeySPKI)),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

export async function verifyInstallationSignature(
  publicKeySPKI: string,
  message: string,
  signature: string,
): Promise<boolean> {
  try {
    const key = await importInstallationKey(publicKeySPKI);
    return crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      exactBuffer(fromBase64URL(signature)),
      encoder.encode(message),
    );
  } catch {
    return false;
  }
}

export function freshTimestamp(value: string, now = Date.now()): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && Math.abs(now - parsed) <= 5 * 60 * 1_000;
}

export async function signedRequestMessage(
  timestamp: string,
  method: string,
  pathname: string,
  body: string,
): Promise<string> {
  return `${timestamp}.${method.toUpperCase()}.${pathname}.${await sha256Text(body)}`;
}

export function installationRegistrationMessage(
  timestamp: string,
  installationId: string,
  publicKey: string,
): string {
  return `${timestamp}.POST./v1/installations.${installationId}.${publicKey}`;
}

function pemBody(value: string): Uint8Array {
  return fromBase64URL(
    value
      .replace(/-----BEGIN [^-]+-----/gu, "")
      .replace(/-----END [^-]+-----/gu, "")
      .replace(/\s+/gu, "")
      .replaceAll("+", "-")
      .replaceAll("/", "_"),
  );
}

export async function createAPNsJWT(input: {
  privateKeyPEM: string;
  keyId: string;
  teamId: string;
  issuedAt?: number;
}): Promise<string> {
  const issuedAt = input.issuedAt ?? Math.floor(Date.now() / 1_000);
  const header = base64URL(encoder.encode(JSON.stringify({ alg: "ES256", kid: input.keyId })));
  const claims = base64URL(encoder.encode(JSON.stringify({ iss: input.teamId, iat: issuedAt })));
  const unsigned = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    exactBuffer(pemBody(input.privateKeyPEM)),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    encoder.encode(unsigned),
  );
  return `${unsigned}.${base64URL(signature)}`;
}
