import type { ClientCommand, Material, MaterialKind } from "@zimlo/protocol";
import { fromBase64Url, makeProof, randomBytes, toBase64Url } from "@zimlo/protocol/crypto";
import { readAllCredentials } from "./credentials";

export const MATERIAL_LIMITS: Record<MaterialKind, number> = {
  image: 8 * 1024 * 1024,
  video: 50 * 1024 * 1024,
  pdf: 20 * 1024 * 1024,
  document: 15 * 1024 * 1024,
};

export interface PreparedMaterial {
  material: Omit<Material, "status" | "error">;
  registerCommand: ClientCommand;
  localPreviewURL: string;
}

export function materialKind(file: File): MaterialKind | null {
  const mime = file.type.toLowerCase();
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"].includes(mime)) return "image";
  if (["jpg", "jpeg", "png", "webp", "heic", "heif"].includes(extension)) return "image";
  if (["video/mp4", "video/quicktime", "video/x-m4v"].includes(mime)) return "video";
  if (["mp4", "mov", "m4v"].includes(extension)) return "video";
  if (mime === "application/pdf") return "pdf";
  if (extension === "pdf") return "pdf";
  if (/^(text\/(?:plain|markdown|csv)|application\/(?:json|msword|vnd\.ms-.+|vnd\.openxmlformats-officedocument\..+))$/u.test(mime)) return "document";
  if (["txt", "md", "csv", "json", "doc", "docx", "xls", "xlsx", "ppt", "pptx"].includes(extension)) return "document";
  return null;
}

export function validateFile(file: File): { kind: MaterialKind } | { error: string } {
  const kind = materialKind(file);
  if (!kind) return { error: "暂不支持这种文件格式" };
  const max = MATERIAL_LIMITS[kind];
  if (file.size <= 0) return { error: "文件内容为空" };
  if (file.size > max) return { error: `${labelForKind(kind)}不能超过 ${Math.round(max / 1024 / 1024)}MB` };
  return { kind };
}

export async function uploadMaterial(file: File, hostId?: string): Promise<PreparedMaterial> {
  const validation = validateFile(file);
  if ("error" in validation) throw new Error(validation.error);
  const allCredentials = await readAllCredentials();
  const credentials = allCredentials.find((value) => value.host.id === hostId) ?? allCredentials[0];
  if (!credentials) throw new Error("请先连接 Mac");
  const id = `material_${crypto.randomUUID().replaceAll("-", "")}`;
  const plaintext = new Uint8Array(await file.arrayBuffer());
  const durationMs = validation.kind === "video" ? await videoDurationMs(file) : undefined;
  if (durationMs !== undefined && durationMs > 180_000) throw new Error("视频不能超过 3 分钟");
  if (validation.kind === "pdf") {
    const pages = new TextDecoder("iso-8859-1").decode(plaintext).match(/\/Type\s*\/Page\b/gu)?.length ?? 0;
    if (pages > 200) throw new Error("PDF 不能超过 200 页");
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", plaintext));
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const imported = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, imported, plaintext));
  const encrypted = new Uint8Array(nonce.length + ciphertext.length);
  encrypted.set(nonce);
  encrypted.set(ciphertext, nonce.length);
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(window.location.hostname);
  const transport = (local && credentials.deviceId.startsWith("local_")) || !credentials.remoteRelayURL ? "local" : "cloud";
  const endpoint = transport === "local"
    ? new URL(`/api/materials/${encodeURIComponent(id)}/blob`, credentials.bridgeURL ?? window.location.href)
    : credentials.remoteRelayURL
      ? new URL(`/v1/materials/${encodeURIComponent(id)}`, credentials.remoteRelayURL)
      : null;
  if (!endpoint) throw new Error("远程物料中转尚不可用，请连接 Mac 后重试");
  const headers: Record<string, string> = { "content-type": "application/octet-stream" };
  if (transport === "cloud") {
    if (!credentials.remoteAccessToken) throw new Error("远程连接凭据缺失，请重新配对");
    headers.authorization = `Bearer ${credentials.remoteAccessToken}`;
  } else {
    const timestamp = new Date().toISOString();
    headers["x-zimlo-device-id"] = credentials.deviceId;
    headers["x-zimlo-timestamp"] = timestamp;
    headers["x-zimlo-proof"] = makeProof(fromBase64Url(credentials.deviceKey), `material-upload:${id}:${timestamp}:${encrypted.byteLength}`);
  }
  const response = await fetch(endpoint, { method: "PUT", headers, body: encrypted });
  if (!response.ok) throw new Error(response.status === 413 ? "文件超过上传限制" : "物料上传失败，请重试");
  const now = new Date().toISOString();
  const material: Omit<Material, "status" | "error"> = {
    id,
    hostId: credentials.host.id,
    kind: validation.kind,
    name: file.name.slice(0, 180),
    mimeType: normalizedMimeType(file, validation.kind),
    sizeBytes: file.size,
    sha256: [...digest].map((value) => value.toString(16).padStart(2, "0")).join(""),
    origin: "user",
    createdAt: now,
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
  return {
    material,
    localPreviewURL: URL.createObjectURL(file),
    registerCommand: {
      type: "material.register",
      hostId: credentials.host.id,
      material,
      transport,
      encryptionKey: toBase64Url(key),
      idempotencyKey: crypto.randomUUID(),
    },
  };
}

function normalizedMimeType(file: File, kind: MaterialKind): string {
  const mime = file.type.toLowerCase();
  const accepted = kind === "image"
    ? ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"].includes(mime)
    : kind === "video"
      ? ["video/mp4", "video/quicktime", "video/x-m4v"].includes(mime)
      : kind === "pdf"
        ? mime === "application/pdf"
        : /^(text\/(?:plain|markdown|csv)|application\/(?:json|msword|vnd\.ms-.+|vnd\.openxmlformats-officedocument\..+))$/u.test(mime);
  if (accepted) return mime;
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const byExtension: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif",
    mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v", pdf: "application/pdf",
    txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  return byExtension[extension] ?? { image: "image/jpeg", video: "video/mp4", pdf: "application/pdf", document: "text/plain" }[kind];
}

async function videoDurationMs(file: File): Promise<number> {
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.src = url;
    const duration = await new Promise<number>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("无法读取视频时长")), 10_000);
      video.onloadedmetadata = () => {
        window.clearTimeout(timer);
        Number.isFinite(video.duration) ? resolve(Math.round(video.duration * 1_000)) : reject(new Error("无法读取视频时长"));
      };
      video.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error("无法读取视频信息"));
      };
    });
    return duration;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function labelForKind(kind: MaterialKind): string {
  return { image: "图片", video: "视频", pdf: "PDF", document: "文件" }[kind];
}

export function formatMaterialSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)}MB` : `${Math.ceil(bytes / 1024)}KB`;
}
