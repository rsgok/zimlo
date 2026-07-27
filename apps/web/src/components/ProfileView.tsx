import { useEffect, useState } from "react";
import { USER_AVATAR_IDS } from "@zimlo/protocol";
import type { ClientCommand, IntegrationStatus, NotificationSettings, Session, UserProfile } from "@zimlo/protocol";
import type { CodexPluginInfo, DeviceInfo, PairingInfo } from "../hooks/useBridge";
import { ProviderBadge } from "./ProviderBadge";
import { UserAvatar } from "./UserAvatar";

interface ProfileViewProps {
  localAdmin: boolean;
  devices: DeviceInfo[];
  pairing: PairingInfo | null;
  lanApprovalsEnabled: boolean;
  codexPlugin: CodexPluginInfo | null;
  integrations: IntegrationStatus[];
  sessions: Session[];
  userProfile: UserProfile;
  notificationSettings?: NotificationSettings | undefined;
  pushRegistered?: boolean | undefined;
  notificationEnabled?: boolean | undefined;
  send: (command: ClientCommand) => boolean;
  forgetDevice: () => Promise<void>;
}

function integrationStateLabel(state: IntegrationStatus["state"]) {
  if (state === "ready") return "可用";
  if (state === "shared") return "共用配置";
  if (state === "partial") return "需要处理";
  return "未连接";
}

export function ProfileView({ localAdmin, devices, pairing, lanApprovalsEnabled, codexPlugin, integrations, sessions, userProfile, notificationSettings = { enabled: false, approvals: true, failures: true, reviews: true, showTaskTitle: false, updatedAt: "" }, pushRegistered = false, notificationEnabled = true, send, forgetDevice }: ProfileViewProps) {
  const [selectedAvatarId, setSelectedAvatarId] = useState(userProfile.avatarId);
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
    const activity = [
      active > 0 ? `${active} 个运行中` : null,
      replyable > 0 ? `${replyable} 个可继续` : null,
    ].filter(Boolean).join(" · ");
    return {
      provider,
      state,
      activity: activity || (runtimeSessions.length > 0 ? `${runtimeSessions.length} 个任务` : "还没有任务"),
    };
  });
  return (
    <section className="profile-view">
      <div className="settings-card user-avatar-card">
        <div className="user-avatar-heading">
          <UserAvatar avatarId={selectedAvatarId} className="user-avatar-current" />
          <div><h3>你的头像</h3><p>会显示在你的指令和 Timeline 中，并同步到已连接设备。</p></div>
        </div>
        <div className="user-avatar-picker" role="list" aria-label="选择用户头像">
          {USER_AVATAR_IDS.map((avatarId, index) => (
            <button
              type="button"
              role="listitem"
              className={avatarId === selectedAvatarId ? "selected" : ""}
              aria-label={`选择头像 ${index + 1}`}
              aria-pressed={avatarId === selectedAvatarId}
              key={avatarId}
              onClick={() => {
                if (send({ type: "user.profile.update", avatarId })) setSelectedAvatarId(avatarId);
              }}
            ><UserAvatar avatarId={avatarId} alt="" /></button>
          ))}
        </div>
      </div>

      <div className="settings-card runtime-overview-card">
        <div className="settings-card-heading">
          <div>
            <h3>Agent 状态</h3>
            <p>确认 Zimlo 现在能否接收新任务、继续已有任务。</p>
          </div>
          {localAdmin && integrations.some((integration) => integration.state === "partial" || integration.state === "unavailable") && (
            <span className="attention-badge">需要处理</span>
          )}
        </div>
        <div className="runtime-overview">
          {runtimeSummary.map((runtime) => (
            <div key={runtime.provider}>
              <ProviderBadge provider={runtime.provider} labelMode="icon" />
              <strong>{runtime.state}</strong>
              <small>{runtime.activity}</small>
            </div>
          ))}
        </div>
        {localAdmin && (
          <div className="settings-actions">
            <button className="primary-button" onClick={() => send({ type: "integrations.cli.install" })}>检查并修复 Agent 接入</button>
          </div>
        )}
      </div>

      {notificationEnabled && <div className="settings-card notification-settings-card">
        <div className="settings-card-heading">
          <div><h3>主动通知</h3><p>{pushRegistered ? "这台设备已经可以接收需要你处理的提醒。" : "配对完成后，可接收审批、失败和结果审阅提醒。"}</p></div>
          <span className={notificationSettings.enabled ? "attention-badge is-ready" : "attention-badge"}>{notificationSettings.enabled ? "已开启" : "已关闭"}</span>
        </div>
        {[
          ["enabled", "允许 Zimlo 通知"],
          ["approvals", "等待批准或回复"],
          ["failures", "任务失败"],
          ["reviews", "结果等待审阅"],
          ["showTaskTitle", "在锁屏显示任务标题"],
        ].map(([key, label]) => {
          const field = key as keyof Omit<NotificationSettings, "updatedAt">;
          return (
            <label className="settings-switch-row" key={key}>
              <span>{label}{field === "showTaskTitle" && <small>关闭时只显示通用隐私文案</small>}</span>
              <button
                type="button"
                role="switch"
                aria-checked={notificationSettings[field]}
                className={`switch ${notificationSettings[field] ? "switch-on" : ""}`}
                onClick={() => send({
                  type: "notification.settings.update",
                  settings: {
                    enabled: notificationSettings.enabled,
                    approvals: notificationSettings.approvals,
                    failures: notificationSettings.failures,
                    reviews: notificationSettings.reviews,
                    showTaskTitle: notificationSettings.showTaskTitle,
                    [field]: !notificationSettings[field],
                  },
                  idempotencyKey: crypto.randomUUID(),
                })}
              ><span /></button>
            </label>
          );
        })}
      </div>}

      {localAdmin && (
        <>
          <div className="settings-card pairing-card">
            <div>
              <h3>连接手机</h3>
              <p>让手机看到同一个 Feed，并可随时回复、继续任务或完成审批。</p>
            </div>
            <button className="primary-button" onClick={() => send({ type: "pairing.create" })}>显示配对二维码</button>
            {pairing && (
              <div className="qr-wrap">
                <img src={pairing.qrDataUrl} alt="Zimlo 手机配对二维码" />
                <small>请在 {new Date(pairing.expiresAt).toLocaleTimeString("zh-CN")} 前扫码</small>
              </div>
            )}
            <div className="pairing-hint">
              <strong>二维码无法生成？</strong>
              <span>请在 Mac 上用 <code>zimlo start --lan</code> 启动。</span>
            </div>
          </div>
          <div className="settings-card device-card">
            <div className="device-heading">
              <div><h3>设备权限</h3><p>控制哪些手机可以完成审批或管理项目自动化。</p></div>
              <button className="text-button" onClick={() => send({ type: "devices.request" })}>刷新</button>
            </div>
            {devices.length === 0 ? <p className="empty-setting">还没有连接手机。</p> : (
              <ul className="device-list">
                {devices.map((device) => (
                  <li key={device.id}>
                    <span><strong>{device.name}</strong><small>{device.isLocalAdmin ? "本机管理" : device.revokedAt ? "已撤销" : "已配对"}</small></span>
                    <time>{new Date(device.lastSeenAt).toLocaleString("zh-CN")}</time>
                    {!device.isLocalAdmin && !device.revokedAt && (
                      <span className="device-permission-switches">
                        <label>
                          <span>审批</span>
                          <button
                            role="switch"
                            aria-label={`${device.name} 手机审批`}
                            aria-checked={device.canApprove}
                            className={`switch ${device.canApprove ? "switch-on" : ""}`}
                            onClick={() => send({ type: "device.approvals.set", deviceId: device.id, enabled: !device.canApprove })}
                          ><span /></button>
                        </label>
                        <label>
                          <span>自动化管理</span>
                          <button
                            role="switch"
                            aria-label={`${device.name} 自动化管理`}
                            aria-checked={device.canManageTrust}
                            className={`switch ${device.canManageTrust ? "switch-on" : ""}`}
                            onClick={() => send({ type: "device.trust.set", deviceId: device.id, enabled: !device.canManageTrust })}
                          ><span /></button>
                        </label>
                        <button
                          className="text-button"
                          onClick={() => send({ type: "device.revoke", deviceId: device.id })}
                        >撤销设备</button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <details className="settings-card technical-settings">
            <summary>
              <span><strong>接入与安全详情</strong><small>GUI、CLI、插件和设备连接信息</small></span>
              <span aria-hidden="true">⌄</span>
            </summary>
            <div className="technical-settings-body">
              <div className="integration-list">
                {integrations.length === 0 ? <p>正在检查本机接入状态…</p> : integrations.map((integration) => (
                  <div className="integration-row" key={integration.id}>
                    <span className={`integration-state integration-state-${integration.state}`} aria-hidden="true" />
                    <span><strong>{integration.label}</strong><small>{integration.detail}</small></span>
                    <em>{integrationStateLabel(integration.state)}</em>
                  </div>
                ))}
              </div>
              <div className="codex-plugin-detail">
                <div>
                  <strong>Codex App 连接</strong>
                  <small>{codexPlugin?.detail ?? "正在检查 Codex App 接入…"}</small>
                </div>
                <div className="settings-actions">
                  <button className="secondary-button" onClick={() => send({ type: "codex.plugin.install" })}>
                    {codexPlugin?.installed ? "重新安装" : "连接 Codex App"}
                  </button>
                  {codexPlugin?.installed && <a className="secondary-button button-link" href={codexPlugin.deepLink}>打开 Codex</a>}
                </div>
              </div>
              <p className="security-note">敏感消息使用设备密钥加密。Zimlo 只会在你点击修复或连接时修改 Agent 配置。</p>
            </div>
          </details>
        </>
      )}
      {!localAdmin && (
        <div className="settings-card phone-permission-card">
          <div>
            <h3>这台手机</h3>
            <p>{lanApprovalsEnabled ? "可以查看、回复和完成审批；高风险操作仍会再次确认。" : "可以查看和回复。审批权限需要在 Mac 的 Zimlo 设置中开启。"}</p>
          </div>
          <button className="secondary-button" onClick={() => void forgetDevice()}>断开这台手机</button>
        </div>
      )}
    </section>
  );
}
