import type { ClientCommand, Material } from "@zimlo/protocol";
import { fromBase64Url } from "@zimlo/protocol/crypto";
import { readAllCredentials } from "./credentials";

const cachedURLs = new Map<string, Promise<string>>();

function localPath(materialId: string): string {
  return `/api/materials/${encodeURIComponent(materialId)}/content`;
}

function isLoopbackPage(): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(window.location.hostname);
}

export function initialMaterialURL(material: Material): string {
  return localPath(material.id);
}

export function materialURL(material: Material, send: (command: ClientCommand) => boolean): Promise<string> {
  const key = `${material.hostId ?? "default"}:${material.id}`;
  const existing = cachedURLs.get(key);
  if (existing) return existing;
  const pending = resolveMaterialURL(material, send).catch((error) => {
    cachedURLs.delete(key);
    throw error;
  });
  cachedURLs.set(key, pending);
  return pending;
}

async function resolveMaterialURL(material: Material, send: (command: ClientCommand) => boolean): Promise<string> {
  const allCredentials = await readAllCredentials();
  const credentials = allCredentials.find((value) => value.host.id === material.hostId) ?? allCredentials[0];
  if (!credentials) throw new Error("请先连接来源 Mac");
  if (isLoopbackPage() && credentials.deviceId.startsWith("local_")) return localPath(material.id);
  if (!credentials.remoteRelayURL || !credentials.remoteAccessToken) throw new Error("来源 Mac 暂无远程物料通道");
  if (!send({ type: "material.remote.request", materialId: material.id, hostId: credentials.host.id })) {
    throw new Error("来源 Mac 当前离线");
  }
  const endpoint = new URL(`/v1/materials/${encodeURIComponent(material.id)}`, credentials.remoteRelayURL);
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const response = await fetch(endpoint, {
      headers: { authorization: `Bearer ${credentials.remoteAccessToken}` },
    });
    if (response.status === 404) {
      await new Promise((resolve) => window.setTimeout(resolve, 450));
      continue;
    }
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "来源 Mac 连接已失效" : `物料读取失败（HTTP ${response.status}）`);
    const encrypted = new Uint8Array(await response.arrayBuffer());
    if (encrypted.byteLength < 29) throw new Error("物料密文无效");
    const deviceKey = Uint8Array.from(fromBase64Url(credentials.deviceKey));
    const hmac = await crypto.subtle.importKey("raw", deviceKey.buffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const contentKey = new Uint8Array(await crypto.subtle.sign("HMAC", hmac, new TextEncoder().encode(`material-download:${material.id}`)));
    const aes = await crypto.subtle.importKey("raw", contentKey.buffer, "AES-GCM", false, ["decrypt"]);
    const nonce = Uint8Array.from(encrypted.slice(0, 12));
    const ciphertext = Uint8Array.from(encrypted.slice(12));
    const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce.buffer }, aes, ciphertext.buffer));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", plaintext));
    const digestHex = [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
    if (digestHex !== material.sha256) throw new Error("物料完整性校验失败");
    void fetch(endpoint, { method: "DELETE", headers: { authorization: `Bearer ${credentials.remoteAccessToken}` } });
    return URL.createObjectURL(new Blob([plaintext], { type: material.mimeType }));
  }
  throw new Error("来源 Mac 暂未回传物料");
}
