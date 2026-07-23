import { describe, expect, it } from "vitest";
import { ClientCommandSchema, USER_AVATAR_IDS, UserProfileSchema } from "../src/index.js";

describe("preset user avatars", () => {
  it("keeps the public avatar library closed to the 24 bundled ids", () => {
    expect(USER_AVATAR_IDS).toHaveLength(24);
    expect(new Set(USER_AVATAR_IDS).size).toBe(24);
    expect(UserProfileSchema.safeParse({ avatarId: "user-24", updatedAt: "2026-07-23T00:00:00.000Z" }).success).toBe(true);
    expect(ClientCommandSchema.safeParse({ type: "user.profile.update", avatarId: "https://example.com/avatar.png" }).success).toBe(false);
    expect(ClientCommandSchema.safeParse({ type: "user.profile.update", avatarId: "user-25" }).success).toBe(false);
  });
});
