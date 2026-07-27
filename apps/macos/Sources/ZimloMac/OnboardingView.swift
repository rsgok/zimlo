import AppKit
import ServiceManagement
import SwiftUI

private enum ZColor {
    static let ink = Color(red: 0.07, green: 0.08, blue: 0.07)
    static let paper = Color(red: 0.97, green: 0.96, blue: 0.92)
    static let acid = Color(red: 0.78, green: 1.0, blue: 0.22)
    static let coral = Color(red: 0.96, green: 0.43, blue: 0.28)
    static let muted = Color(red: 0.45, green: 0.45, blue: 0.41)
}

struct OnboardingView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        HStack(spacing: 0) {
            OnboardingSidebar(step: model.onboarding.step)
                .frame(width: 235)
            Group {
                switch model.onboarding.step {
                case 0: WelcomeStep(model: model)
                case 1: AgentStep(model: model)
                case 2: PhoneStep(model: model)
                default: CompleteStep(model: model)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(ZColor.paper)
        }
        .frame(minWidth: 760, minHeight: 540)
        .background(ZColor.ink)
        .preferredColorScheme(.light)
    }
}

private struct OnboardingSidebar: View {
    let step: Int
    private let labels = ["开始", "连接 Agent", "连接手机", "完成"]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                ZimloMark(size: 38)
                VStack(alignment: .leading, spacing: 1) {
                    Text("ZIMLO").font(.system(size: 15, weight: .black, design: .rounded))
                    Text("把 Agent 带在身边").font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.46))
                }
            }
            .padding(.bottom, 56)

            VStack(alignment: .leading, spacing: 23) {
                ForEach(Array(labels.enumerated()), id: \.offset) { index, label in
                    HStack(spacing: 12) {
                        ZStack {
                            Circle()
                                .fill(index <= step ? ZColor.acid : Color.white.opacity(0.1))
                                .frame(width: 25, height: 25)
                            if index < step {
                                Image(systemName: "checkmark")
                                    .font(.system(size: 10, weight: .black))
                                    .foregroundStyle(ZColor.ink)
                            } else {
                                Text("\(index + 1)")
                                    .font(.system(size: 10, weight: .black, design: .monospaced))
                                    .foregroundStyle(index == step ? ZColor.ink : .white.opacity(0.44))
                            }
                        }
                        Text(label)
                            .font(.system(size: 12, weight: index == step ? .bold : .medium))
                            .foregroundStyle(index == step ? .white : .white.opacity(0.42))
                    }
                }
            }
            Spacer()
            Text("任务正文和代码不会存进云端")
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(.white.opacity(0.35))
        }
        .padding(30)
        .foregroundStyle(.white)
    }
}

private struct WelcomeStep: View {
    @ObservedObject var model: AppModel

    var body: some View {
        StepShell {
            VStack(alignment: .leading, spacing: 22) {
                StatusPill(
                    label: model.service.state.label,
                    ready: model.service.isReady
                )
                Text("离开电脑，\n也不会错过 Agent。")
                    .font(.system(size: 42, weight: .black, design: .rounded))
                    .tracking(-1.4)
                    .foregroundStyle(ZColor.ink)
                Text("Zimlo 把 Codex 和 Claude Code 真正需要你处理的内容送到手机：审批、失败和待审结果。")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(ZColor.muted)
                    .lineSpacing(5)
                    .frame(maxWidth: 480, alignment: .leading)
                HStack(spacing: 12) {
                    ValueChip(icon: "bell.badge", text: "只提醒重要事项")
                    ValueChip(icon: "lock.shield", text: "端到端加密")
                    ValueChip(icon: "bolt", text: "后台自动运行")
                }
            }
        } footer: {
            PrimaryButton("继续", disabled: !model.service.isReady) {
                model.onboarding.step = 1
            }
            if case .unavailable(let message) = model.service.state {
                VStack(alignment: .trailing, spacing: 5) {
                    Text(message).font(.system(size: 11, weight: .semibold)).foregroundStyle(ZColor.coral)
                    Button("重新准备") { Task { await model.service.start() } }
                        .buttonStyle(.plain).font(.system(size: 11, weight: .bold))
                }
            }
        }
    }
}

private struct AgentStep: View {
    @ObservedObject var model: AppModel

    private var allReady: Bool {
        let integrations = model.service.status?.integrations ?? []
        return !integrations.isEmpty && integrations.allSatisfy(\.isReady)
    }

    private var groups: [(String, [IntegrationStatus])] {
        let values = model.service.status?.integrations ?? []
        return [
            ("Codex", values.filter { $0.provider == "codex" }),
            ("Claude Code", values.filter { $0.provider == "claude" }),
        ]
    }

    var body: some View {
        StepShell {
            Text("连接你已经在用的 Agent")
                .font(.system(size: 31, weight: .black, design: .rounded))
            Text("Zimlo 只会在你确认后准备接入配置。已有设置会保留，也可以随时移除。")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(ZColor.muted)
                .padding(.top, 3)

            VStack(spacing: 12) {
                ForEach(groups, id: \.0) { label, values in
                    IntegrationCard(label: label, values: values)
                }
            }
            .padding(.top, 18)
        } footer: {
            Button("稍后设置") { model.onboarding.step = 2 }
                .buttonStyle(.plain)
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(ZColor.muted)
            Spacer()
            if !allReady {
                SecondaryButton(model.service.busy ? "正在连接…" : "一键连接") {
                    Task { await model.service.installIntegration("all") }
                }
            }
            PrimaryButton("继续", disabled: model.service.busy) {
                model.onboarding.step = 2
            }
        }
    }
}

private struct PhoneStep: View {
    @ObservedObject var model: AppModel

    private var isPaired: Bool {
        (model.service.status?.pairedDeviceCount ?? 0) > 0
    }

    var body: some View {
        StepShell {
            HStack(alignment: .top, spacing: 34) {
                VStack(alignment: .leading, spacing: 16) {
                    Text(isPaired ? "手机已经连接" : "把 Zimlo 带到手机")
                        .font(.system(size: 31, weight: .black, design: .rounded))
                    Text(isPaired
                         ? "这台 iPhone 已安全配对。离开当前 Wi-Fi 后，Zimlo 会自动切换到加密云连接。"
                         : "打开 iPhone 上的 Zimlo 扫描二维码。手机和 Mac 不需要连接同一个 Wi-Fi。")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(ZColor.muted)
                        .lineSpacing(4)
                    if isPaired {
                        Label("配对密钥只保存在你的设备上", systemImage: "checkmark.shield")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(ZColor.muted)
                    } else {
                        Label("二维码 2 分钟后自动失效", systemImage: "timer")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(ZColor.muted)
                        Label("云端只转发加密连接", systemImage: "lock.shield")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(ZColor.muted)
                    }
                }
                Spacer()
                PairingCard(service: model.service, isPaired: isPaired)
            }
        } footer: {
            Button("暂不连接手机") { model.onboarding.step = 3 }
                .buttonStyle(.plain)
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(ZColor.muted)
            Spacer()
            PrimaryButton(isPaired ? "继续" : "等待手机连接", disabled: !isPaired) {
                model.onboarding.step = 3
            }
        }
        .task {
            if model.service.pairing == nil {
                await model.service.createPairing()
            }
            while !Task.isCancelled && !isPaired {
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled else { return }
                _ = await model.service.refreshStatus()
            }
        }
    }
}

private struct CompleteStep: View {
    @ObservedObject var model: AppModel

    var body: some View {
        StepShell {
            Spacer()
            ZStack {
                Circle().fill(ZColor.acid).frame(width: 76, height: 76)
                Image(systemName: "checkmark")
                    .font(.system(size: 29, weight: .black))
                    .foregroundStyle(ZColor.ink)
            }
            Text("Zimlo 已经准备好了")
                .font(.system(size: 34, weight: .black, design: .rounded))
            Text("它会继续在菜单栏运行。下一次 Agent 需要你时，打开手机就能处理。")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(ZColor.muted)
                .multilineTextAlignment(.center)
                .lineSpacing(4)
                .frame(maxWidth: 430)
            Spacer()
        } footer: {
            SecondaryButton("打开控制台") { model.service.openDashboard() }
            Spacer()
            PrimaryButton("完成", disabled: false) {
                model.onboarding.finish()
                WindowCoordinator.shared.closeOnboarding()
            }
        }
    }
}

struct MenuPanel: View {
    @ObservedObject var model: AppModel
    @State private var launchAtLogin = SMAppService.mainApp.status == .enabled

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                ZimloMark(size: 38)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Zimlo")
                        .font(.system(size: 15, weight: .black, design: .rounded))
                        .foregroundStyle(ZColor.ink)
                    Text(model.service.isReady ? "正在守候重要任务" : "正在恢复连接")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(ZColor.muted)
                }
                Spacer()
                Circle()
                    .fill(model.service.isReady ? ZColor.acid : Color.orange)
                    .frame(width: 9, height: 9)
            }
            .padding(18)

            Divider()

            VStack(spacing: 4) {
                MenuAction(icon: "rectangle.stack", label: "打开 Zimlo") {
                    model.service.openDashboard()
                }
                MenuAction(icon: "qrcode", label: "连接手机") {
                    model.onboarding.step = 2
                    WindowCoordinator.shared.showOnboarding()
                }
                MenuAction(icon: "wand.and.stars", label: "设置 Agent") {
                    model.onboarding.step = 1
                    WindowCoordinator.shared.showOnboarding()
                }
                if model.updates.isConfigured {
                    MenuAction(icon: "arrow.triangle.2.circlepath", label: "检查更新") {
                        model.updates.checkForUpdates()
                    }
                }
            }
            .padding(10)

            Divider()

            Toggle(isOn: $launchAtLogin) {
                Label("登录时自动启动", systemImage: "power")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(ZColor.ink)
            }
            .toggleStyle(.switch)
            .tint(ZColor.acid)
            .controlSize(.small)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .onChange(of: launchAtLogin) { _, enabled in
                do {
                    if enabled { try SMAppService.mainApp.register() }
                    else { try SMAppService.mainApp.unregister() }
                } catch {
                    launchAtLogin = SMAppService.mainApp.status == .enabled
                }
            }

            Divider()

            HStack {
                Button("退出 Zimlo") { NSApp.terminate(nil) }
                    .buttonStyle(.plain)
                    .foregroundStyle(ZColor.ink)
                Spacer()
                Text("0.3 Beta").foregroundStyle(ZColor.muted)
            }
            .font(.system(size: 10, weight: .semibold))
            .padding(16)
        }
        .frame(width: 310)
        .foregroundStyle(ZColor.ink)
        .background(ZColor.paper)
        .preferredColorScheme(.light)
    }
}

private struct StepShell<Content: View, Footer: View>: View {
    @ViewBuilder let content: Content
    @ViewBuilder let footer: Footer

    init(
        @ViewBuilder content: () -> Content,
        @ViewBuilder footer: () -> Footer
    ) {
        self.content = content()
        self.footer = footer()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                content
            }
            .padding(.horizontal, 48)
            .padding(.top, 58)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)

            Divider()
            HStack(spacing: 12) {
                footer
            }
            .padding(.horizontal, 28)
            .frame(height: 78)
        }
    }
}

private struct PairingCard: View {
    @ObservedObject var service: ServiceController
    let isPaired: Bool

    var body: some View {
        VStack(spacing: 13) {
            ZStack {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(.white)
                if isPaired {
                    VStack(spacing: 12) {
                        ZStack {
                            Circle().fill(ZColor.acid).frame(width: 72, height: 72)
                            Image(systemName: "checkmark")
                                .font(.system(size: 30, weight: .black))
                                .foregroundStyle(ZColor.ink)
                        }
                        Text("iPhone 已连接")
                            .font(.system(size: 13, weight: .black))
                            .foregroundStyle(ZColor.ink)
                    }
                } else if let image = service.pairing?.qrImage {
                    Image(nsImage: image)
                        .resizable()
                        .interpolation(.none)
                        .scaledToFit()
                        .padding(16)
                } else if service.busy {
                    ProgressView().controlSize(.large)
                } else {
                    Image(systemName: "wifi.exclamationmark")
                        .font(.system(size: 28, weight: .medium))
                        .foregroundStyle(ZColor.muted)
                }
            }
            .frame(width: 222, height: 222)
            .overlay(RoundedRectangle(cornerRadius: 20).stroke(Color.black.opacity(0.08)))

            if !isPaired {
                Button("刷新二维码") {
                    Task { await service.createPairing() }
                }
                .buttonStyle(.plain)
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(ZColor.muted)
            }
        }
    }
}

private struct IntegrationCard: View {
    let label: String
    let values: [IntegrationStatus]

    private var ready: Bool {
        values.contains(where: \.isReady)
    }

    private var detail: String {
        guard !values.isEmpty else { return "正在检查本机配置…" }
        let readyValues = values.filter(\.isReady)
        if readyValues.count == values.count {
            return label == "Codex"
                ? "Codex App 与 CLI 均已连接"
                : "Claude App 与 CLI 均已连接"
        }
        if let connected = readyValues.first {
            return "\(connected.surface == "gui" ? "App" : "CLI") 已连接；另一接入方式仍待配置"
        }
        return values.first?.detail ?? "尚未连接"
    }

    var body: some View {
        HStack(spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 13).fill(ready ? ZColor.acid.opacity(0.42) : Color.black.opacity(0.05))
                Text(String(label.prefix(1)))
                    .font(.system(size: 16, weight: .black, design: .rounded))
            }
            .frame(width: 44, height: 44)
            VStack(alignment: .leading, spacing: 4) {
                Text(label).font(.system(size: 13, weight: .bold))
                Text(detail)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(ZColor.muted)
                    .lineLimit(2)
            }
            Spacer()
            Text(ready ? "已连接" : "可稍后连接")
                .font(.system(size: 9, weight: .black))
                .padding(.horizontal, 9)
                .padding(.vertical, 6)
                .background(ready ? ZColor.acid : Color.black.opacity(0.06))
                .clipShape(Capsule())
        }
        .padding(15)
        .background(.white.opacity(0.7))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color.black.opacity(0.07)))
    }
}

private struct ZimloMark: View {
    let size: CGFloat

    var body: some View {
        ZStack {
            Circle().fill(ZColor.acid)
            Circle().stroke(Color.white.opacity(0.55), lineWidth: 2).padding(4)
            Image(systemName: "sparkles")
                .font(.system(size: size * 0.34, weight: .black))
                .foregroundStyle(ZColor.ink)
        }
        .frame(width: size, height: size)
    }
}

private struct StatusPill: View {
    let label: String
    let ready: Bool

    var body: some View {
        HStack(spacing: 7) {
            Circle().fill(ready ? ZColor.acid : Color.orange).frame(width: 7, height: 7)
            Text(label.uppercased())
                .font(.system(size: 10, weight: .black, design: .monospaced))
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 7)
        .background(ZColor.ink)
        .foregroundStyle(.white)
        .clipShape(Capsule())
    }
}

private struct ValueChip: View {
    let icon: String
    let text: String

    var body: some View {
        Label(text, systemImage: icon)
            .font(.system(size: 10, weight: .bold))
            .padding(.horizontal, 11)
            .padding(.vertical, 8)
            .background(Color.black.opacity(0.055))
            .clipShape(Capsule())
    }
}

private struct PrimaryButton: View {
    let label: String
    let disabled: Bool
    let action: () -> Void

    init(_ label: String, disabled: Bool, action: @escaping () -> Void) {
        self.label = label
        self.disabled = disabled
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(label)
                Image(systemName: "arrow.right")
            }
            .font(.system(size: 12, weight: .black))
            .padding(.horizontal, 19)
            .frame(height: 40)
            .foregroundStyle(ZColor.ink)
            .background(ZColor.acid)
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.35 : 1)
    }
}

private struct SecondaryButton: View {
    let label: String
    let action: () -> Void

    init(_ label: String, action: @escaping () -> Void) {
        self.label = label
        self.action = action
    }

    var body: some View {
        Button(label, action: action)
            .buttonStyle(.plain)
            .font(.system(size: 12, weight: .bold))
            .padding(.horizontal, 17)
            .frame(height: 40)
            .background(Color.black.opacity(0.06))
            .clipShape(Capsule())
    }
}

private struct MenuAction: View {
    let icon: String
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: icon).frame(width: 18)
                Text(label)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(ZColor.muted)
            }
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(ZColor.ink)
            .contentShape(Rectangle())
            .padding(.horizontal, 8)
            .frame(height: 36)
        }
        .buttonStyle(.plain)
    }
}
