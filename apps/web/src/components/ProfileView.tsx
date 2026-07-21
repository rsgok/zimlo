import type { ClientCommand } from "@zimlo/protocol";
import type { DeviceInfo, PairingInfo } from "../hooks/useBridge";

interface ProfileViewProps {
  localAdmin: boolean;
  devices: DeviceInfo[];
  pairing: PairingInfo | null;
  lanApprovalsEnabled: boolean;
  send: (command: ClientCommand) => void;
  forgetDevice: () => Promise<void>;
}

export function ProfileView({ localAdmin, devices, pairing, lanApprovalsEnabled, send, forgetDevice }: ProfileViewProps) {
  return (
    <section className="profile-view">
      <div className="section-heading">
        <p className="eyebrow">设备与安全</p>
        <h2>{localAdmin ? "Mac 本机管理" : "已配对浏览器"}</h2>
      </div>
      <div className="settings-card">
        <div>
          <h3>连接状态</h3>
          <p>WebSocket 的敏感消息使用设备密钥加密；初始网页仍受可信局域网边界限制。</p>
        </div>
        {!localAdmin && <button className="secondary-button" onClick={() => void forgetDevice()}>忘记此设备</button>}
      </div>

      {localAdmin && (
        <>
          <div className="settings-card settings-toggle">
            <div>
              <h3>允许本次运行接受 LAN 审批</h3>
              <p>Bridge 每次重启都会恢复为关闭。高风险、Session 和永久决策仍要求确认短语。</p>
            </div>
            <button
              role="switch"
              aria-checked={lanApprovalsEnabled}
              className={`switch ${lanApprovalsEnabled ? "switch-on" : ""}`}
              onClick={() => send({ type: "lan.approvals.set", enabled: !lanApprovalsEnabled })}
            ><span /></button>
          </div>
          <div className="settings-card pairing-card">
            <div>
              <h3>配对手机 Safari</h3>
              <p>二维码两分钟有效且只能使用一次。需要用 <code>zimlo start --lan</code> 启动。</p>
            </div>
            <button className="primary-button" onClick={() => send({ type: "pairing.create" })}>生成二维码</button>
            {pairing && (
              <div className="qr-wrap">
                <img src={pairing.qrDataUrl} alt="Zimlo 手机配对二维码" />
                <small>有效至 {new Date(pairing.expiresAt).toLocaleTimeString("zh-CN")}</small>
              </div>
            )}
          </div>
          <div className="settings-card device-card">
            <div className="device-heading">
              <h3>已知设备</h3>
              <button className="text-button" onClick={() => send({ type: "devices.request" })}>刷新</button>
            </div>
            {devices.length === 0 ? <p>点击刷新查看。命令行可用 <code>zimlo devices revoke</code> 立即撤销。</p> : (
              <ul className="device-list">
                {devices.map((device) => (
                  <li key={device.id}>
                    <span><strong>{device.name}</strong><small>{device.isLocalAdmin ? "本机管理" : device.revokedAt ? "已撤销" : "已配对"}</small></span>
                    <time>{new Date(device.lastSeenAt).toLocaleString("zh-CN")}</time>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
