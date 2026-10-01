import type { ClientCommand, Material } from "@zimlo/protocol";
import { fromBase64Url } from "@zimlo/protocol/crypto";
import { withMaterialTransferSlot } from "./materialTransfer";
import { readAllCredentials } from "./credentials";

interface CacheEntry { pending: Promise<string>; url?: string; size: number; readers: number; controller: AbortController }
const cachedURLs = new Map<string, CacheEntry>();
function cacheKey(material: Material): string { return `${material.hostId ?? "default"}:${material.id}:${material.sha256}`; }
function pruneCache(): void {
  let unusedBytes = [...cachedURLs.values()].filter((entry) => entry.readers === 0).reduce((sum, entry) => sum + entry.size, 0);
  for (const [key, entry] of cachedURLs) {
    if (entry.readers !== 0 || !entry.url || (cachedURLs.size <= 32 && unusedBytes <= 128 * 1024 * 1024)) continue;
    cachedURLs.delete(key); unusedBytes -= entry.size;
    if (entry.url.startsWith("blob:")) URL.revokeObjectURL(entry.url);
  }
}
export function releaseMaterialURL(material: Material): void {
  const entry = cachedURLs.get(cacheKey(material));
  if (entry) {
    entry.readers = Math.max(0, entry.readers - 1);
    if (entry.readers === 0 && !entry.url) { cachedURLs.delete(cacheKey(material)); entry.controller.abort(); }
  }
  pruneCache();
}

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
  const key = cacheKey(material);
  const existing = cachedURLs.get(key);
  if (existing) { existing.readers += 1; cachedURLs.delete(key); cachedURLs.set(key, existing); return existing.pending; }
  const entry: CacheEntry = { pending: Promise.resolve(""), size: material.sizeBytes, readers: 1, controller: new AbortController() };
  entry.pending = withMaterialTransferSlot(() => resolveMaterialURL(material, send, entry.controller.signal)).then((url) => { entry.url = url; pruneCache(); return url; }).catch((error) => {
    if (cachedURLs.get(key) === entry) cachedURLs.delete(key); throw error;
  });
  cachedURLs.set(key, entry);
  return entry.pending;
}

async function resolveMaterialURL(material: Material, send: (command: ClientCommand) => boolean, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const allCredentials = await readAllCredentials();
  const credentials = material.hostId ? allCredentials.find((value) => value.host.id === material.hostId) : allCredentials[0];
  if (!credentials) throw new Error("请先连接来源 Mac");
  if (isLoopbackPage() && credentials.deviceId.startsWith("local_") && new URL(credentials.bridgeURL ?? window.location.href).origin === window.location.origin) return localPath(material.id);
  if (!credentials.remoteRelayURL || !credentials.remoteAccessToken) throw new Error("来源 Mac 暂无远程物料通道");
  if (!send({ type: "material.remote.request", materialId: material.id, hostId: credentials.host.id })) {
    throw new Error("来源 Mac 当前离线");
  }
  const endpoint = new URL(`/v1/materials/${encodeURIComponent(material.id)}`, credentials.remoteRelayURL);
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const response = await fetch(endpoint, {
      signal,
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
    signal.throwIfAborted();
    return URL.createObjectURL(new Blob([plaintext], { type: material.mimeType }));
  }
  throw new Error("来源 Mac 暂未回传物料");
}
