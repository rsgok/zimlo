import { describe, expect, it } from "vitest";
import { HostSchema } from "../src/index.js";

const host = {
  id: "host_019a1234",
  name: "Build Server",
  lastSeenAt: "2026-09-04T00:00:00.000Z",
};

describe("HostSchema", () => {
  it.each(["macos", "linux", "windows", "unknown"] as const)(
    "accepts the %s platform",
    (platform) => {
      expect(HostSchema.safeParse({ ...host, platform }).success).toBe(true);
    },
  );

  it("rejects unversioned platform strings", () => {
    expect(HostSchema.safeParse({ ...host, platform: "freebsd" }).success).toBe(false);
  });
});
