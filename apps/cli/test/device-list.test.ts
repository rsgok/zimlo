import { describe, expect, it } from "vitest";
import { formatDeviceList, type DeviceListRow } from "../src/device-list.js";

function device(overrides: Partial<DeviceListRow>): DeviceListRow {
  return {
    id: "device-1",
    name: "iPhone",
    lastSeenAt: "2026-07-29T00:00:00.000Z",
    revokedAt: null,
    isLocalAdmin: false,
    ...overrides,
  };
}

describe("formatDeviceList", () => {
  it("shows the empty state when nothing is paired", () => {
    expect(formatDeviceList([])).toContain("暂无已配对设备");
    expect(formatDeviceList([])).toContain("zimlo open");
  });

  it("excludes the loopback local-admin device from the paired list", () => {
    expect(formatDeviceList([device({ isLocalAdmin: true })])).toContain("暂无已配对设备");
  });

  it("renders a header and one row per paired device", () => {
    const text = formatDeviceList([
      device({ id: "device-1", name: "iPhone" }),
      device({ id: "device-2", name: "iPad", revokedAt: "2026-07-29T01:00:00.000Z" }),
    ]);
    const lines = text.split("\n");
    expect(lines[0]).toContain("状态");
    expect(lines[0]).toContain("名称");
    expect(lines[0]).toContain("最近活跃");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("active");
    expect(lines[1]).toContain("iPhone");
    expect(lines[2]).toContain("revoked");
    expect(lines[2]).toContain("iPad");
  });
});
