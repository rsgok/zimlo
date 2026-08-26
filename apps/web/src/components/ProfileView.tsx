import { useEffect, useState } from "react";
import type { ClientCommand, Host, IntegrationStatus, NotificationSettings, Session, UserProfile } from "@zimlo/protocol";
import type { CodexPluginInfo, DeviceInfo, PairingInfo } from "../hooks/useBridge";
import { AppIcon } from "./AppIcon";
import { ConfirmDialog } from "./ConfirmDialog";
import { ProviderBadge } from "./ProviderBadge";
import { AvatarPickerDialog, PairingDialog } from "./SettingsDialogs";
import { UserAvatar } from "./UserAvatar";

interface ProfileViewProps {
  localAdmin: boolean;
  devices: DeviceInfo[];
  pairing: PairingInfo | null;
  lanApprovalsEnabled: boolean;
  trustManagementEnabled: boolean;
  codexPlugin: CodexPluginInfo | null;
  integrations: IntegrationStatus[];
  sessions: Session[];
  userProfile: UserProfile;
  notificationSettings?: NotificationSettings | undefined;
  pushRegistered?: boolean | undefined;
  notificationEnabled?: boolean | undefined;
  connected?: boolean | undefined;
  connectionMode?: "offline" | "local" | "cloud" | "multi" | undefined;
  hosts?: Array<Host & { connected: boolean; connectionMode: "offline" | "local" | "cloud"; isLocal: boolean }> | undefined;
  send: (command: ClientCommand) => boolean;
  forgetDevice: () => Promise<void>;
  pairAdditionalHost?: ((link: string) => Promise<void>) | undefined;
  forgetHost?: ((hostId: string) => Promise<void>) | undefined;
}

function integrationStateLabel(state: IntegrationStatus["state"]) {
  if (state === "ready") return "可用";
  if (state === "shared") return "共用配置";
  if (state === "partial") return "需要处理";
  return "未连接";
}

function providerLabel(provider: "codex" | "claude") {
  return provider === "codex" ? "Codex" : "Claude Code";
}

function devicePermissionSummary(device: DeviceInfo) {
  if (device.canApprove && device.canManageTrust) return "审批与自动化已开启";
  if (device.canApprove) return "已开启审批";
  if (device.canManageTrust) return "已开启自动化";
  return "权限已关闭";
}

export function ProfileView({ localAdmin, devices, pairing, lanApprovalsEnabled, trustManagementEnabled, codexPlugin, integrations, sessions, userProfile, notificationSettings = { enabled: false, approvals: true, results: true, failures: true, criticalOnly: false, quietHoursEnabled: false, timeZoneOffsetMinutes: 0, showTaskTitle: false, updatedAt: "" }, pushRegistered = false, notificationEnabled = true, connected = false, connectionMode = "offline", hosts = [], send, forgetDevice, pairAdditionalHost = async () => {}, forgetHost = async () => {} }: ProfileViewProps) {
  const [selectedAvatarId, setSelectedAvatarId] = useState(userProfile.avatarId);
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [confirmForgetPhone, setConfirmForgetPhone] = useState(false);
  const [confirmRevokeDevice, setConfirmRevokeDevice] = useState<DeviceInfo | null>(null);
  const [addingHost, setAddingHost] = useState(false);
  const [hostLink, setHostLink] = useState("");
  const [hostError, setHostError] = useState<string | null>(null);
  const [hostConnecting, setHostConnecting] = useState(false);
  const [hostPendingRemoval, setHostPendingRemoval] = useState<Host | null>(null);
  useEffect(() => setSelectedAvatarId(userProfile.avatarId), [userProfile.avatarId]);

  const runtimeSummary = (["codex", "claude"] as const).map((provider) => {
    const runtimeSessions = sessions.filter((session) => session.provider === provider);
    const runtimeIntegrations = integrations.filter((integration) => integration.provider === provider);
    const usableIntegrationCount = runtimeIntegrations.filter((integration) => integration.state === "ready" || integration.state === "shared").length;
    const needsAttention = runtimeIntegrations.some((integration) => integration.state === "partial");
    const unavailableCount = runtimeIntegrations.filter((integration) => integration.state === "unavailable").length;
    const checking = localAdmin && integrations.length === 0;
    let state = "未连接";
    if (checking) state = "正在检查";
    else if (needsAttention || (usableIntegrationCount > 0 && unavailableCount > 0)) state = "部分可用";
    else if (usableIntegrationCount > 0 || runtimeSessions.length > 0) state = "可用";

    const active = runtimeSessions.filter((session) => session.status === "running" || session.status === "waiting").length;
    const replyable = runtimeSessions.filter((session) => session.capabilities.replyable).length;
    const activity = [active > 0 ? `${active} 运行中` : null, replyable > 0 ? `${replyable} 可继续` : null].filter(Boolean).join(" · ");
    return { provider, state, activity: activity || (runtimeSessions.length > 0 ? `${runtimeSessions.length} 个任务` : "暂无任务") };
  });
  const activeDevices = devices.filter((device) => !device.revokedAt);
  const pairedDevices = activeDevices.filter((device) => !device.isLocalAdmin);
  const revokedDeviceCount = devices.length - activeDevices.length;
  const connectedPhoneCount = pairedDevices.length;
  const modeLabel = connected ? (connectionMode === "multi" ? "多设备" : connectionMode === "cloud" ? "云端" : "本地") : "离线";

  const openPairing = () => {
    setPairingOpen(true);
    send({ type: "pairing.create" });
  };

  return (
    <section className="profile-view settings-dashboard">
      <div className="settings-profile-card">
        <button type="button" className="avatar-edit-button" onClick={() => setAvatarPickerOpen(true)} aria-label="更换头像">
          <UserAvatar avatarId={selectedAvatarId} className="user-avatar-current" />
          <span aria-hidden="true">✎</span>
        </button>
        <div className="settings-profile-copy">
          <h2>Zimlo</h2>
          <p><i className={connected ? "is-connected" : ""} aria-hidden="true" />{localAdmin ? "这台 Mac" : "这台设备"} · {connected ? "已连接" : "未连接"}</p>
        </div>
        <span className={`settings-connection-mode ${connected ? "is-connected" : ""}`}>{modeLabel}</span>
      </div>

      <section className="settings-section" aria-labelledby="runtime-settings-title">
        <div className="settings-section-heading">
          <h3 id="runtime-settings-title">Runtime</h3>
          {localAdmin && <button type="button" className="settings-icon-action" aria-label="检查 Runtime 接入" title="检查接入" onClick={() => send({ type: "integrations.cli.install" })}><AppIcon name="refresh" /></button>}
        </div>
        <div className="settings-card runtime-overview-card">
          <div className="runtime-overview">
            {runtimeSummary.map((runtime) => (
              <div key={runtime.provider}>
                <ProviderBadge provider={runtime.provider} labelMode="icon" />
                <span><strong>{providerLabel(runtime.provider)}</strong><small>{runtime.activity}</small></span>
                <em className={runtime.state === "可用" ? "is-ready" : ""}>{runtime.state}</em>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="host-settings-title">
        <h3 id="host-settings-title">运行设备</h3>
        <div className="settings-card settings-list-card host-list-card">
          {hosts.map((host) => (
            <div className="settings-value-row" key={host.id}>
              <span><strong>{host.name}</strong><small>{host.connected ? (host.connectionMode === "cloud" ? "远程连接" : "本机连接") : "离线，操作会保留在队列"}</small></span>
              <i className={`host-status-dot ${host.connected ? "is-connected" : ""}`} aria-label={host.connected ? "在线" : "离线"} />
              {hosts.length > 1 && !host.isLocal && <button type="button" className="host-remove-button" aria-label={`移除 ${host.name}`} onClick={() => setHostPendingRemoval(host)}>×</button>}
            </div>
          ))}
          {hosts.length === 0 && <p className="empty-setting">还没有连接运行设备</p>}
          <button type="button" className="settings-value-row host-add-row" onClick={() => { setAddingHost((value) => !value); setHostError(null); }}>
            <span><strong>连接另一台 Mac</strong><small>粘贴那台 Mac 上生成的连接码</small></span><b aria-hidden="true">＋</b>
          </button>
          {addingHost && <form className="host-pair-form" onSubmit={(event) => {
            event.preventDefault();
            setHostConnecting(true);
            setHostError(null);
            void pairAdditionalHost(hostLink).catch((error: unknown) => {
              setHostError(error instanceof Error ? error.message : String(error));
              setHostConnecting(false);
            });
          }}>
            <input value={hostLink} onChange={(event) => setHostLink(event.target.value)} placeholder="粘贴 zimlo 连接码" aria-label="另一台 Mac 的连接码" />
            <button type="submit" className="secondary-button" disabled={hostConnecting || hostLink.trim().length === 0}>{hostConnecting ? "连接中" : "连接"}</button>
            {hostError && <p role="alert">{hostError}</p>}
          </form>}
        </div>
      </section>

      {notificationEnabled && <section className="settings-section" aria-labelledby="notification-settings-title">
        <h3 id="notification-settings-title">通知</h3>
        <div className="settings-card notification-settings-card">
          <div className="settings-card-heading">
            <strong>{pushRegistered ? "这台设备可接收通知" : "配对后可接收通知"}</strong>
            <span className={notificationSettings.enabled ? "attention-badge is-ready" : "attention-badge"}>{notificationSettings.enabled ? "已开启" : "已关闭"}</span>
          </div>
          {([
            ["enabled", "允许 Zimlo 通知"],
            ["approvals", "审批与回复"],
            ["results", "任务完成与重要结果"],
            ["failures", "任务失败"],
            ["criticalOnly", "仅关键通知"],
            ["quietHoursEnabled", "安静时段（22:00–08:00）"],
            ["showTaskTitle", "锁屏任务信息（标题与摘要）"],
          ] satisfies Array<[Exclude<keyof NotificationSettings, "updatedAt" | "timeZoneOffsetMinutes">, string]>).map(([field, label]) => {
            return (
              <label className="settings-switch-row" key={field}>
                <span>{label}</span>
                <button
                  type="button"
                  role="switch"
                  aria-label={label}
                  aria-checked={notificationSettings[field]}
                  className={`switch ${notificationSettings[field] ? "switch-on" : ""}`}
                  onClick={() => send({
                    type: "notification.settings.update",
                    settings: {
                      enabled: field === "enabled" ? !notificationSettings.enabled : notificationSettings.enabled,
                      approvals: field === "approvals" ? !notificationSettings.approvals : notificationSettings.approvals,
                      results: field === "results" ? !notificationSettings.results : notificationSettings.results,
                      failures: field === "failures" ? !notificationSettings.failures : notificationSettings.failures,
                      criticalOnly: field === "criticalOnly" ? !notificationSettings.criticalOnly : notificationSettings.criticalOnly,
                      quietHoursEnabled: field === "quietHoursEnabled" ? !notificationSettings.quietHoursEnabled : notificationSettings.quietHoursEnabled,
                      timeZoneOffsetMinutes: notificationSettings.timeZoneOffsetMinutes,
                      showTaskTitle: field === "showTaskTitle" ? !notificationSettings.showTaskTitle : notificationSettings.showTaskTitle,
                    },
                    idempotencyKey: crypto.randomUUID(),
                  })}
                ><span /></button>
              </label>
            );
          })}
        </div>
      </section>}

      {localAdmin && (
        <>
          <section className="settings-section" aria-labelledby="phone-settings-title">
            <h3 id="phone-settings-title">手机</h3>
            <div className="settings-card settings-list-card">
              <div className="settings-value-row">
                <span><strong>连接新手机</strong><small>{connectedPhoneCount > 0 ? `${connectedPhoneCount} 台已连接` : "尚未连接"}</small></span>
                <button className="primary-button" onClick={openPairing}>显示二维码</button>
              </div>
            </div>
          </section>

          <section className="settings-section" aria-labelledby="device-settings-title">
            <div className="settings-section-heading">
              <h3 id="device-settings-title">设备</h3>
              <button type="button" className="settings-icon-action" aria-label="刷新设备" title="刷新" onClick={() => send({ type: "devices.request" })}><AppIcon name="refresh" /></button>
            </div>
            <div className="settings-card device-card">
              {pairedDevices.length === 0 ? <p className="empty-setting">还没有连接设备</p> : (
                <ul className="device-list">
                  {pairedDevices.map((device) => (
                    <li key={device.id}>
                      <details className="device-item">
                        <summary>
                          <span className="device-icon" aria-hidden="true"><AppIcon name="device" /></span>
                          <span className="device-summary-copy">
                            <strong>{device.name}</strong>
                            <small>已配对 · 最近使用 {new Date(device.lastSeenAt).toLocaleString("zh-CN")}</small>
                          </span>
                          <span className={`device-grant-summary ${device.canApprove && device.canManageTrust ? "is-enabled" : ""}`}>{devicePermissionSummary(device)}</span>
                          <span className="device-disclosure" aria-hidden="true"><AppIcon name="chevron-down" /></span>
                        </summary>
                        <div className="device-controls">
                          <div className="settings-switch-row">
                            <span><strong>审批与回复</strong><small>允许这台设备处理 Agent 的待办操作</small></span>
                            <button role="switch" aria-label={`${device.name} 手机审批`} aria-checked={device.canApprove} className={`switch ${device.canApprove ? "switch-on" : ""}`} onClick={() => send({ type: "device.approvals.set", deviceId: device.id, enabled: !device.canApprove })}><span /></button>
                          </div>
                          <div className="settings-switch-row">
                            <span><strong>安全自动化</strong><small>允许管理项目内的安全自动化规则</small></span>
                            <button role="switch" aria-label={`${device.name} 自动化管理`} aria-checked={device.canManageTrust} className={`switch ${device.canManageTrust ? "switch-on" : ""}`} onClick={() => send({ type: "device.trust.set", deviceId: device.id, enabled: !device.canManageTrust })}><span /></button>
                          </div>
                          <button type="button" className="device-revoke-row" onClick={() => setConfirmRevokeDevice(device)}><span>撤销设备</span><small>断开后需要重新配对</small></button>
                        </div>
                      </details>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <details className="settings-card technical-settings">
            <summary>
              <span><strong>接入与安全</strong><small>{revokedDeviceCount > 0 ? `${revokedDeviceCount} 条已撤销设备记录 · GUI、CLI 与插件` : "GUI、CLI 与插件"}</small></span>
              <span aria-hidden="true">⌄</span>
            </summary>
            <div className="technical-settings-body">
              <div className="integration-list">
                {integrations.length === 0 ? <p>正在检查本机接入状态…</p> : integrations.map((integration) => (
                  <div className="integration-row" key={integration.id}>
                    <span className={`integration-state integration-state-${integration.state}`} aria-hidden="true" />
                    <span>
                      <strong>{integration.label}</strong>
                      <small>{integration.detail}</small>
                    </span>
                    <em>{integrationStateLabel(integration.state)}</em>
                  </div>
                ))}
              </div>
              <div className="codex-plugin-detail">
                <div><strong>Codex App</strong><small>{codexPlugin?.detail ?? "正在检查…"}</small></div>
                <div className="settings-actions">
                  <button className="secondary-button" onClick={() => send({ type: "codex.plugin.install" })}>{codexPlugin?.installed ? "重新安装" : "连接"}</button>
                  {codexPlugin?.installed && <a className="secondary-button button-link" href={codexPlugin.deepLink}>打开 Codex</a>}
                </div>
              </div>
              <p className="security-note">敏感消息使用设备密钥加密；仅在你主动点击时修改接入配置。</p>
            </div>
          </details>
        </>
      )}

      {!localAdmin && (
        <section className="settings-section">
          <h3>这台手机</h3>
          <div className="settings-card settings-list-card phone-permission-card">
            <div className="settings-value-row"><span><strong>审批与回复</strong><small>处理 Agent 的待办操作</small></span><em>{lanApprovalsEnabled ? "已开启" : "已关闭"}</em></div>
            <div className="settings-value-row"><span><strong>安全自动化</strong><small>管理项目内的自动化规则</small></span><em>{trustManagementEnabled ? "已开启" : "已关闭"}</em></div>
            <button className="device-revoke-row" onClick={() => setConfirmForgetPhone(true)}><span>断开这台手机</span><small>断开后需要重新配对</small></button>
          </div>
        </section>
      )}

      {avatarPickerOpen && <AvatarPickerDialog selectedAvatarId={selectedAvatarId} onClose={() => setAvatarPickerOpen(false)} onSelect={(avatarId) => {
        if (send({ type: "user.profile.update", avatarId })) {
          setSelectedAvatarId(avatarId);
          setAvatarPickerOpen(false);
        }
      }} />}
      {pairingOpen && <PairingDialog pairing={pairing} onRefresh={() => send({ type: "pairing.create" })} onClose={() => setPairingOpen(false)} />}
      {confirmForgetPhone && <ConfirmDialog title="断开这台手机？" body="这台手机的配对信息会被清除，需要重新扫码才能连接。" confirmLabel="断开手机" onConfirm={() => void forgetDevice()} onCancel={() => setConfirmForgetPhone(false)} />}
      {confirmRevokeDevice && <ConfirmDialog title={`撤销「${confirmRevokeDevice.name}」？`} body="这台设备会立即失去连接，需要重新配对才能恢复。" confirmLabel="撤销设备" onConfirm={() => {
        send({ type: "device.revoke", deviceId: confirmRevokeDevice.id });
        setConfirmRevokeDevice(null);
      }} onCancel={() => setConfirmRevokeDevice(null)} />}
      {hostPendingRemoval && <ConfirmDialog title={`移除「${hostPendingRemoval.name}」？`} body="只移除这台 Mac；其他运行设备和聚合 Feed 不受影响。" confirmLabel="移除连接" onConfirm={() => void forgetHost(hostPendingRemoval.id)} onCancel={() => setHostPendingRemoval(null)} />}
    </section>
  );
}
