import SwiftUI
import UIKit

struct NotificationSettingsSection: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("通知").font(ZFont.caption2).foregroundStyle(ZColor.muted).padding(.leading, 3)
            VStack(alignment: .leading, spacing: 0) {
                Toggle(isOn: notificationsEnabled) {
                    label("通知", systemImage: "bell.fill")
                }
                .tint(ZColor.acid)
                .padding(.vertical, 3)
                .disabled(!model.snapshot.features.pushNotifications)

                if !model.snapshot.features.pushNotifications {
                    divider
                    valueRow("推送服务", value: "暂不可用", systemImage: "exclamationmark.triangle.fill", emphasized: true)
                }
                divider
                valueRow("系统权限", value: model.notificationPermission, systemImage: "bell.badge.fill")
                divider
                valueRow(
                    "APNs 注册",
                    value: activeRegistration.map { $0.environment == "development" ? "已注册 · 开发" : "已注册 · 生产" } ?? "未注册",
                    systemImage: activeRegistration == nil ? "antenna.radiowaves.left.and.right.slash" : "antenna.radiowaves.left.and.right"
                )
                divider
                valueRow(
                    "最近投递",
                    value: lastDeliveryLabel,
                    systemImage: activeRegistration?.lastDeliveryStatus == 200 ? "checkmark.circle.fill" : "waveform.path.ecg"
                )

                if model.notificationPermission == "系统已拒绝" {
                    divider
                    Button {
                        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                        UIApplication.shared.open(url)
                    } label: {
                        valueRow("系统权限", value: "打开设置", systemImage: "gearshape.fill", emphasized: true)
                    }
                    .buttonStyle(.plain)
                }

                if model.snapshot.notificationSettings.enabled {
                    divider
                    notificationToggle("审批与回复", keyPath: \.approvals)
                    divider
                    notificationToggle("任务完成与重要结果", keyPath: \.results)
                    divider
                    notificationToggle("任务失败", keyPath: \.failures)
                    divider
                    notificationToggle("仅关键通知", keyPath: \.criticalOnly)
                    divider
                    notificationToggle("安静时段（22:00–08:00）", keyPath: \.quietHoursEnabled)
                    divider
                    notificationToggle("锁屏任务信息（标题与摘要）", keyPath: \.showTaskTitle)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 8)
            .foregroundStyle(ZColor.ink)
            .background(ZColor.raised)
            .overlay(RoundedRectangle(cornerRadius: ZRadius.inner, style: .continuous).stroke(ZColor.line))
            .clipShape(RoundedRectangle(cornerRadius: ZRadius.inner, style: .continuous))
        }
    }

    private var divider: some View { Divider().overlay(ZColor.line) }

    private var notificationsEnabled: Binding<Bool> {
        Binding(
            get: { model.snapshot.notificationSettings.enabled },
            set: { enabled in
                if enabled { model.requestNotifications() }
                else {
                    var settings = model.snapshot.notificationSettings
                    settings.enabled = false
                    model.updateNotificationSettings(settings)
                }
            }
        )
    }

    private var activeRegistration: PushDeviceRegistration? {
        model.snapshot.pushDevices.first(where: \.active)
    }

    private var lastDeliveryLabel: String {
        guard let registration = activeRegistration,
              let status = registration.lastDeliveryStatus else { return "尚无记录" }
        let result = status == 200 ? "成功" : status == -1 ? "网络失败" : "失败（\(status)）"
        guard let text = registration.lastDeliveryAt,
              let date = (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(text))
                ?? (try? Date.ISO8601FormatStyle(includingFractionalSeconds: false).parse(text)) else { return result }
        return "\(result) · \(date.formatted(date: .abbreviated, time: .shortened))"
    }

    private func label(_ title: String, systemImage: String) -> some View {
        Label {
            Text(title).font(ZFont.subheadline.weight(.semibold))
        } icon: {
            Image(systemName: systemImage).foregroundStyle(ZColor.sageText).frame(width: 20)
        }
    }

    private func valueRow(_ title: String, value: String, systemImage: String, emphasized: Bool = false) -> some View {
        HStack(spacing: 11) {
            label(title, systemImage: systemImage)
            Spacer()
            Text(value).foregroundStyle(emphasized ? ZColor.sageText : ZColor.muted)
        }
        .font(ZFont.subheadline)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }

    private func notificationToggle(_ title: String, keyPath: WritableKeyPath<NotificationSettings, Bool>) -> some View {
        Toggle(title, isOn: Binding(
            get: { model.snapshot.notificationSettings[keyPath: keyPath] },
            set: { value in
                var settings = model.snapshot.notificationSettings
                settings[keyPath: keyPath] = value
                model.updateNotificationSettings(settings)
            }
        ))
        .font(ZFont.subheadline.weight(.semibold))
        .tint(ZColor.acid)
        .frame(minHeight: 44)
    }
}
