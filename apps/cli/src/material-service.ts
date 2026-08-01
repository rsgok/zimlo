import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { Material } from "@zimlo/protocol";
import { fromBase64Url, makeProof } from "@zimlo/protocol/crypto";
import type { CloudService } from "./cloud-service.js";
import type { RuntimeHub } from "./runtime.js";

export const MATERIAL_LIMITS = {
  image: 8 * 1024 * 1024,
  video: 50 * 1024 * 1024,
  pdf: 20 * 1024 * 1024,
  document: 15 * 1024 * 1024,
  taskTotal: 80 * 1024 * 1024,
  taskCount: 10,
} as const;

const MIME_BY_KIND: Record<Material["kind"], readonly RegExp[]> = {
  image: [/^image\/(?:jpeg|png|webp|heic|heif)$/u],
  video: [/^video\/(?:mp4|quicktime|x-m4v)$/u],
  pdf: [/^application\/pdf$/u],
  document: [
    /^text\/(?:plain|markdown|csv)$/u,
    /^application\/(?:json|vnd\.openxmlformats-officedocument\..+|msword|vnd\.ms-.+)$/u,
  ],
};

export interface MaterialRegistration {
  material: Omit<Material, "status" | "error">;
  transport: "local" | "cloud";
  encryptionKey: string;
}

function safeExtension(name: string): string {
  const value = extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/u.test(value) ? value : "";
}

export function validateMaterial(material: Omit<Material, "status" | "error">): string | null {
  const limit = MATERIAL_LIMITS[material.kind];
  if (material.sizeBytes > limit) return `${material.kind} 文件超过 ${Math.round(limit / 1024 / 1024)}MB 限制。`;
  if (!MIME_BY_KIND[material.kind].some((rule) => rule.test(material.mimeType.toLowerCase()))) return "文件格式不受支持。";
  if (material.kind === "video" && material.durationMs && material.durationMs > 180_000) return "视频不能超过 3 分钟。";
  return null;
}

export function validateMaterialContent(data: Buffer, material: Omit<Material, "status" | "error">): string | null {
  const ascii = data.subarray(0, 16).toString("latin1");
  if (material.kind === "image") {
    const jpeg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    const png = data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const webp = ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP";
    const heif = ascii.slice(4, 8) === "ftyp" && /(?:heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1)/u.test(ascii.slice(8));
    if (!jpeg && !png && !webp && !heif) return "图片内容与声明格式不一致。";
  }
  if (material.kind === "video" && ascii.slice(4, 8) !== "ftyp") return "视频内容与声明格式不一致。";
  if (material.kind === "pdf") {
    if (!ascii.startsWith("%PDF-")) return "PDF 内容与声明格式不一致。";
    const detectedPages = data.toString("latin1").match(/\/Type\s*\/Page\b/gu)?.length ?? 0;
    if (detectedPages > 200) return "PDF 不能超过 200 页。";
  }
  if (material.kind === "document") {
    const zip = data[0] === 0x50 && data[1] === 0x4b;
    const ole = data.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    const text = !data.subarray(0, Math.min(data.length, 4_096)).includes(0);
    if (!zip && !ole && !text) return "文档内容与声明格式不一致。";
  }
  return null;
}

export class MaterialService {
  private readonly materialsPath: string;
  private readonly stagingPath: string;

  constructor(
    private readonly runtime: RuntimeHub,
    private readonly cloud: CloudService,
  ) {
    const paths = runtime.store.materialStoragePaths();
    this.materialsPath = paths.materials;
    this.stagingPath = paths.staging;
    mkdirSync(this.materialsPath, { recursive: true, mode: 0o700 });
    mkdirSync(this.stagingPath, { recursive: true, mode: 0o700 });
  }

  verifyLocalProof(deviceId: string, materialId: string, timestamp: string, size: number, proof: string): boolean {
    const device = this.runtime.store.getDevice(deviceId);
    if (!device || device.revokedAt || !timestamp || Math.abs(Date.now() - new Date(timestamp).getTime()) > 5 * 60_000) return false;
    const expected = makeProof(fromBase64Url(device.keyBase64), `material-upload:${materialId}:${timestamp}:${size}`);
    const left = Buffer.from(expected);
    const right = Buffer.from(proof);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  verifyContentProof(deviceId: string, materialId: string, timestamp: string, proof: string): boolean {
    const device = this.runtime.store.getDevice(deviceId);
    if (!device || device.revokedAt || !timestamp || Math.abs(Date.now() - new Date(timestamp).getTime()) > 5 * 60_000) return false;
    const expected = makeProof(fromBase64Url(device.keyBase64), `material-download:${materialId}:${timestamp}`);
    const left = Buffer.from(expected);
    const right = Buffer.from(proof);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  receiveLocalBlob(deviceId: string, materialId: string, body: Buffer): void {
    if (!/^material_[a-zA-Z0-9_-]{12,140}$/u.test(materialId)) throw new Error("material_id_invalid");
    if (body.length > MATERIAL_LIMITS.video + 64) throw new Error("material_too_large");
    const directory = join(this.stagingPath, deviceId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${materialId}.enc`);
    writeFileSync(path, body, { mode: 0o600 });
    chmodSync(path, 0o600);
  }

  async register(deviceId: string, input: MaterialRegistration): Promise<Material> {
    const invalid = validateMaterial(input.material);
    if (invalid) return this.fail(input.material, invalid);
    const existing = this.runtime.store.getMaterial(input.material.id);
    if (existing?.status === "ready") return existing;
    try {
      const encrypted = input.transport === "cloud"
        ? await this.cloud.downloadMaterial(deviceId, input.material.id)
        : this.readStaged(deviceId, input.material.id);
      if (!encrypted) throw new Error("找不到已上传的物料，请重新选择。");
      const plaintext = decryptCombined(encrypted, input.encryptionKey);
      if (plaintext.length !== input.material.sizeBytes) throw new Error("物料大小校验失败。");
      const invalidContent = validateMaterialContent(plaintext, input.material);
      if (invalidContent) throw new Error(invalidContent);
      const digest = createHash("sha256").update(plaintext).digest("hex");
      if (digest !== input.material.sha256) throw new Error("物料完整性校验失败。");
      const finalPath = join(this.materialsPath, `${input.material.id}${safeExtension(input.material.name)}`);
      const temporary = `${finalPath}.tmp`;
      writeFileSync(temporary, plaintext, { mode: 0o600 });
      renameSync(temporary, finalPath);
      chmodSync(finalPath, 0o600);
      const material: Material = { ...input.material, status: "ready" };
      const stored = this.runtime.store.upsertMaterial(material, finalPath);
      this.cleanupStaged(deviceId, input.material.id);
      if (input.transport === "cloud") void this.cloud.deleteMaterial(deviceId, input.material.id);
      this.runtime.send({ type: "material.updated", material: stored });
      return stored;
    } catch (error) {
      const failed = this.fail(input.material, error instanceof Error ? error.message : String(error));
      this.runtime.send({ type: "material.updated", material: failed });
      return failed;
    }
  }

  paths(ids: string[]): string[] {
    return ids.flatMap((id) => {
      const material = this.runtime.store.getMaterial(id);
      const path = this.runtime.store.materialLocalPath(id);
      return material?.status === "ready" && path && existsSync(path) ? [path] : [];
    });
  }

  content(id: string): { material: Material; data: Buffer } | null {
    const material = this.runtime.store.getMaterial(id);
    const path = this.runtime.store.materialLocalPath(id);
    if (!material || material.status !== "ready" || !path || !existsSync(path)) return null;
    return { material, data: readFileSync(path) };
  }

  async publishRemoteCopy(deviceId: string, materialId: string): Promise<boolean> {
    const device = this.runtime.store.getDevice(deviceId);
    const content = this.content(materialId);
    if (!device || device.revokedAt || !content) return false;
    const deviceKey = Buffer.from(fromBase64Url(device.keyBase64));
    if (deviceKey.length !== 32) return false;
    const key = createHmac("sha256", deviceKey).update(`material-download:${materialId}`).digest();
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const encrypted = Buffer.concat([nonce, cipher.update(content.data), cipher.final(), cipher.getAuthTag()]);
    await this.cloud.uploadMaterialForDevice(deviceId, materialId, encrypted);
    return true;
  }

  private readStaged(deviceId: string, materialId: string): Buffer | null {
    const path = join(this.stagingPath, deviceId, `${materialId}.enc`);
    return existsSync(path) ? readFileSync(path) : null;
  }

  private cleanupStaged(deviceId: string, materialId: string): void {
    const path = join(this.stagingPath, deviceId, `${materialId}.enc`);
    if (existsSync(path)) unlinkSync(path);
  }

  private fail(material: Omit<Material, "status" | "error">, message: string): Material {
    return this.runtime.store.upsertMaterial({ ...material, status: "failed", error: message.slice(0, 500) }, null);
  }
}

function decryptCombined(value: Buffer, encodedKey: string): Buffer {
  if (value.length < 28) throw new Error("物料密文无效。");
  const key = Buffer.from(fromBase64Url(encodedKey));
  if (key.length !== 32) throw new Error("物料密钥无效。");
  const nonce = value.subarray(0, 12);
  const tag = value.subarray(value.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(value.subarray(12, value.length - 16)), decipher.final()]);
}
