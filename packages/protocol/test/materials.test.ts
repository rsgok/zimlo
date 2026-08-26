import { describe, expect, it } from "vitest";
import {
  ClientCommandSchema,
  FeedPostInputSchema,
  MaterialSchema,
  NotificationSettingsSchema,
  PushDeviceRegistrationSchema,
  SnapshotSchema,
} from "../src/index.js";

const image = {
  id: "material_0123456789abcdef",
  kind: "image" as const,
  name: "screen.png",
  mimeType: "image/png",
  sizeBytes: 120_000,
  sha256: "a".repeat(64),
  width: 1200,
  height: 800,
  origin: "user" as const,
  status: "ready" as const,
  createdAt: "2026-08-01T00:00:00.000Z",
};

describe("material protocol", () => {
  it("accepts safe metadata without transport paths or plaintext bytes", () => {
    expect(MaterialSchema.parse(image)).toEqual(image);
    expect(MaterialSchema.safeParse({ ...image, sizeBytes: 51 * 1024 * 1024 }).success).toBe(false);
  });

  it("models image, video and document feed cards independently from editorial copy", () => {
    const base = {
      task_id: "task-1", kind: "result", template: "paper", headline: "完成",
      takeaway: "结果已可查看", dedupe_key: "task-1:result", highlights: [],
    };
    expect(FeedPostInputSchema.safeParse({ ...base, content: { type: "image_album", materialIds: [image.id] } }).success).toBe(true);
    expect(FeedPostInputSchema.safeParse({ ...base, content: { type: "video", materialId: image.id } }).success).toBe(true);
    expect(FeedPostInputSchema.safeParse({ ...base, content: { type: "document", materialId: image.id } }).success).toBe(true);
  });

  it("keeps task commands small by referencing at most ten material ids", () => {
    const command = {
      type: "task.create", provider: "codex", workspaceId: "workspace-1", text: "检查这些素材",
      materialIds: [image.id], idempotencyKey: "command-1",
    };
    expect(ClientCommandSchema.safeParse(command).success).toBe(true);
    expect(ClientCommandSchema.safeParse({ ...command, materialIds: Array.from({ length: 11 }, (_, index) => `material_${index}`) }).success).toBe(false);
  });

  it("allows a paired device to request an existing material without putting bytes on the socket", () => {
    expect(ClientCommandSchema.safeParse({
      type: "material.remote.request",
      materialId: image.id,
    }).success).toBe(true);
    expect(ClientCommandSchema.safeParse({
      type: "material.remote.request",
      materialId: "../../secret",
    }).success).toBe(false);
  });

  it("decodes older snapshots without a materials array", () => {
    expect(SnapshotSchema.shape.materials.parse(undefined)).toEqual([]);
  });

  it("defaults new notification policy and diagnostics fields for older clients", () => {
    expect(NotificationSettingsSchema.parse({
      enabled: true, approvals: true, failures: true, showTaskTitle: false, updatedAt: "",
    })).toEqual(expect.objectContaining({
      results: true, criticalOnly: false, quietHoursEnabled: false, timeZoneOffsetMinutes: 0,
    }));
    expect(PushDeviceRegistrationSchema.parse({
      deviceId: "device_phone", platform: "ios", endpoint: "device_phone", publicKey: "key",
      active: true, registeredAt: "", updatedAt: "",
    })).toEqual(expect.objectContaining({ environment: "production" }));
  });
});
