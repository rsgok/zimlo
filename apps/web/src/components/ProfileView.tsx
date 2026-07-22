import type { ClientCommand, Session } from "@zimlo/protocol";
import type { CodexPluginInfo, DeviceInfo, PairingInfo } from "../hooks/useBridge";

interface ProfileViewProps {
  localAdmin: boolean;
  devices: DeviceInfo[];
  pairing: PairingInfo | null;
  lanApprovalsEnabled: boolean;
  codexPlugin: CodexPluginInfo | null;
  sessions: Session[];
  send: (command: ClientCommand) => void;
  forgetDevice: () => Promise<void>;
}

export function ProfileView({ localAdmin, devices, pairing, lanApprovalsEnabled, codexPlugin, sessions, send, forgetDevice }: ProfileViewProps) {
  const runtimeSummary = (["codex", "claude"] as const).map((provider) => {
    const runtimeSessions = sessions.filter((session) => session.provider === provider);
    return {
      provider,
      label: provider === "codex" ? "Codex" : "Claude Code",
      total: runtimeSessions.length,
      active: runtimeSessions.filter((session) => session.status === "running" || session.status === "waiting").length,
      replyable: runtimeSessions.filter((session) => session.capabilities.replyable).length,
    };
  });
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

      <div className="settings-card runtime-overview-card">
        <div>
          <h3>Agent 工作能力</h3>
          <p>发现、审阅、审批和继续任务都在同一处完成。</p>
        </div>
        <div className="runtime-overview">
          {runtimeSummary.map((runtime) => (
            <div key={runtime.provider}>
              <span className={`provider provider-${runtime.provider}`}>{runtime.label}</span>
              <strong>{runtime.total > 0 ? "已连接" : "等待任务"}</strong>
              <small>{runtime.active} 个运行中 · {runtime.replyable} 个可继续</small>
            </div>
          ))}
        </div>
      </div>

      {localAdmin && (
        <>
          <div className="settings-card codex-plugin-card">
            <div>
              <h3>Codex GUI 发帖插件</h3>
              <p>{codexPlugin?.detail ?? "正在检查 Codex GUI 集成…"}</p>
              <small>插件让新任务获得发帖与状态工具，并按需自动启动 Zimlo；普通对话可静默结束，无需输入 /hooks。</small>
            </div>
            <div className="settings-actions">
              <button className="primary-button" onClick={() => send({ type: "codex.plugin.install" })}>
                {codexPlugin?.installed ? "重新安装 / 修复" : "准备 Codex 插件"}
              </button>
              {codexPlugin?.installed && (
                <a className="secondary-button button-link" href={codexPlugin.deepLink}>在 Codex 中打开</a>
              )}
            </div>
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
                    {!device.isLocalAdmin && !device.revokedAt && (
                      <button
                        role="switch"
                        aria-label={`${device.name} 手机审批`}
                        aria-checked={device.canApprove}
                        className={`switch ${device.canApprove ? "switch-on" : ""}`}
                        onClick={() => send({ type: "device.approvals.set", deviceId: device.id, enabled: !device.canApprove })}
                      ><span /></button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
      {!localAdmin && (
        <div className="settings-card">
          <div>
            <h3>手机审批权限</h3>
            <p>{lanApprovalsEnabled ? "已由 Mac 持久授权；高风险操作仍要求确认短语。" : "尚未授权。请在 Mac 的 Zimlo Profile 中为这台设备开启。"}</p>
          </div>
        </div>
      )}
    </section>
  );
}
