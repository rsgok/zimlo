import type { ClientCommand, IntegrationStatus, Session } from "@zimlo/protocol";
import type { CodexPluginInfo, DeviceInfo, PairingInfo } from "../hooks/useBridge";
import { surfaceLabel } from "./sessionPresentation";

interface ProfileViewProps {
  localAdmin: boolean;
  devices: DeviceInfo[];
  pairing: PairingInfo | null;
  lanApprovalsEnabled: boolean;
  codexPlugin: CodexPluginInfo | null;
  integrations: IntegrationStatus[];
  sessions: Session[];
  send: (command: ClientCommand) => void;
  forgetDevice: () => Promise<void>;
}

export function ProfileView({ localAdmin, devices, pairing, lanApprovalsEnabled, codexPlugin, integrations, sessions, send, forgetDevice }: ProfileViewProps) {
  const runtimeSummary = (["codex", "claude"] as const).map((provider) => {
    const runtimeSessions = sessions.filter((session) => session.provider === provider);
    return {
      provider,
      label: provider === "codex" ? "Codex" : "Claude Code",
      total: runtimeSessions.length,
      active: runtimeSessions.filter((session) => session.status === "running" || session.status === "waiting").length,
      replyable: runtimeSessions.filter((session) => session.capabilities.replyable).length,
      surfaces: (["gui", "cli", "managed", "unknown"] as const)
        .map((surface) => ({ surface, count: runtimeSessions.filter((session) => session.surface === surface).length }))
        .filter((item) => item.count > 0),
    };
  });
  return (
    <section className="profile-view">
      <div className="section-heading">
        <p className="eyebrow">SETTINGS</p>
        <h2>{localAdmin ? "设备、接入与安全" : "当前设备设置"}</h2>
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
          <h3>Runtime 工作能力</h3>
          <p>Codex 和 Claude Code 是 Project Agent 可替换的执行引擎。</p>
        </div>
        <div className="runtime-overview">
          {runtimeSummary.map((runtime) => (
            <div key={runtime.provider}>
              <span className={`provider provider-${runtime.provider}`}>{runtime.label}</span>
              <strong>{runtime.total > 0 ? "已连接" : "等待任务"}</strong>
              <small>{runtime.active} 个运行中 · {runtime.replyable} 个可继续</small>
              {runtime.surfaces.length > 0 && (
                <span className="surface-summary">{runtime.surfaces.map((item) => `${surfaceLabel(item.surface)} ${item.count}`).join(" · ")}</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {localAdmin && (
        <>
          <div className="settings-card integration-card">
            <div>
              <h3>Runtime 接入方式</h3>
              <p>Provider 和运行界面分开记录；同一个 Session 在 GUI、CLI 或 Zimlo 托管之间恢复时不会被拆成多个任务。</p>
            </div>
            <div className="integration-list">
              {integrations.length === 0 ? <p>正在检查本机接入状态…</p> : integrations.map((integration) => (
                <div className="integration-row" key={integration.id}>
                  <span className={`integration-state integration-state-${integration.state}`} aria-hidden="true" />
                  <span><strong>{integration.label}</strong><small>{integration.detail}</small></span>
                  <em>{integration.state === "ready" ? "已就绪" : integration.state === "shared" ? "共享配置" : integration.state === "partial" ? "需修复" : "未配置"}</em>
                </div>
              ))}
            </div>
            <p className="integration-note">Zimlo 不会在启动时静默修改 Agent 配置；配置完成后，MCP 会按需自动启动 Bridge。</p>
            <div className="settings-actions">
              <button className="primary-button" onClick={() => send({ type: "integrations.cli.install" })}>配置 / 修复 CLI 接入</button>
            </div>
          </div>
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
            <p>{lanApprovalsEnabled ? "已由 Mac 持久授权；高风险操作仍要求确认短语。" : "尚未授权。请在 Mac 的 Zimlo Settings 中为这台设备开启。"}</p>
          </div>
        </div>
      )}
    </section>
  );
}
