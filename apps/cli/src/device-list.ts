// `zimlo devices list` 的输出格式：表头 + 空态，本机管理设备（loopback 内部
// 设备）不计入已配对设备。
export interface DeviceListRow {
  id: string;
  name: string;
  lastSeenAt: string;
  revokedAt: string | null;
  isLocalAdmin: boolean;
}

export function formatDeviceList(devices: readonly DeviceListRow[]): string {
  const paired = devices.filter((device) => !device.isLocalAdmin);
  if (paired.length === 0) {
    return "暂无已配对设备。运行 zimlo open 打开管理页，用手机扫码配对。";
  }
  const header = `${"状态".padEnd(8)}${"ID".padEnd(38)}${"名称".padEnd(18)}最近活跃`;
  const rows = paired.map((device) => (
    `${(device.revokedAt ? "revoked" : "active").padEnd(8)}${device.id.padEnd(38)}${device.name.padEnd(18)}${device.lastSeenAt}`
  ));
  return [header, ...rows].join("\n");
}
