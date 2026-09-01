import AppKit
import ServiceManagement
import SwiftUI

enum ZColor {
    static let ink = Color(red: 0.92, green: 0.94, blue: 0.91)
    static let paper = Color(red: 0.045, green: 0.052, blue: 0.049)
    static let sidebar = Color(red: 0.028, green: 0.034, blue: 0.032)
    static let surface = Color(red: 0.075, green: 0.088, blue: 0.082)
    static let surfaceRaised = Color(red: 0.105, green: 0.122, blue: 0.113)
    static let surfaceHover = Color(red: 0.14, green: 0.16, blue: 0.15)
    static let acid = Color(red: 0.43, green: 0.62, blue: 0.36)
    static let acidSoft = acid.opacity(0.18)
    static let onAccent = Color(red: 0.045, green: 0.065, blue: 0.049)
    static let coral = Color(red: 0.83, green: 0.49, blue: 0.42)
    static let coralSoft = coral.opacity(0.15)
    static let warning = Color(red: 0.76, green: 0.58, blue: 0.34)
    static let muted = Color(red: 0.61, green: 0.65, blue: 0.62)
    static let subtle = Color(red: 0.47, green: 0.51, blue: 0.48)
    static let border = Color.white.opacity(0.10)
    static let divider = Color.white.opacity(0.075)
    static let qrPaper = Color(red: 0.95, green: 0.95, blue: 0.91)
}

struct OnboardingView: View {
    let model: AppModel
    @ObservedObject private var onboarding: OnboardingStore

    init(model: AppModel) {
        self.model = model
        _onboarding = ObservedObject(wrappedValue: model.onboarding)
    }

    var body: some View {
        HStack(spacing: 0) {
            OnboardingSidebar(step: onboarding.step)
                .frame(width: 235)
            Group {
                switch onboarding.step {
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
        .background(ZColor.paper)
        .preferredColorScheme(.dark)
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
                    Text("把 Agent 带在身边").font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(ZColor.muted)
                }
            }
            .padding(.bottom, 56)

            VStack(alignment: .leading, spacing: 23) {
                ForEach(Array(labels.enumerated()), id: \.offset) { index, label in
                    HStack(spacing: 12) {
                        ZStack {
                            Circle()
                                .fill(index <= step ? ZColor.acid : ZColor.surfaceRaised)
                                .frame(width: 25, height: 25)
                            if index < step {
                                Image(systemName: "checkmark")
                                    .font(.system(size: 12, weight: .black))
                                    .foregroundStyle(ZColor.onAccent)
                            } else {
                                Text("\(index + 1)")
                                    .font(.system(size: 12, weight: .black, design: .monospaced))
                                    .foregroundStyle(index == step ? ZColor.onAccent : ZColor.muted)
                            }
                        }
                        Text(label)
                            .font(.system(size: 12, weight: index == step ? .bold : .medium))
                            .foregroundStyle(index == step ? ZColor.ink : ZColor.muted)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(index == step ? ZColor.surfaceRaised : .clear)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("第 \(index + 1) 步，共 \(labels.count) 步：\(label)")
                    .accessibilityValue(index < step ? "已完成" : (index == step ? "当前步骤" : "未开始"))
                }
            }
            Spacer()
            Text("任务正文和代码不会存进云端")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(ZColor.subtle)
        }
        .padding(30)
        .foregroundStyle(ZColor.ink)
        .background(ZColor.sidebar)
        .overlay(alignment: .trailing) {
            Rectangle().fill(ZColor.divider).frame(width: 1)
        }
        .accessibilityElement(children: .contain)
    }
}

private struct WelcomeStep: View {
    let model: AppModel
    @ObservedObject private var service: ServiceController

    init(model: AppModel) {
        self.model = model
        _service = ObservedObject(wrappedValue: model.service)
    }

    var body: some View {
        StepShell {
            VStack(alignment: .leading, spacing: 22) {
                StatusPill(
                    label: service.state.label,
                    ready: service.isReady
                )
                Text("离开电脑，\n也不会错过 Agent。")
                    .font(.system(size: 42, weight: .black, design: .rounded))
                    .tracking(-1.4)
                    .foregroundStyle(ZColor.ink)
                Text("Zimlo 把 Codex 和 Claude Code 值得阅读的结果、真实审批与失败提醒送到手机。")
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
            Spacer()
            if case .manualStopped = service.state {
                VStack(alignment: .trailing, spacing: 5) {
                    Text("后台服务已通过 zimlo stop 手动停止。")
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(ZColor.muted)
                    Button("启动服务") { Task { await service.retry() } }
                        .buttonStyle(.plain).font(.system(size: 12, weight: .bold))
                        .foregroundStyle(ZColor.acid)
                        .accessibilityLabel("启动后台服务")
                }
            }
            if let message = service.state.recoveryMessage {
                VStack(alignment: .trailing, spacing: 5) {
                    Text(message).font(.system(size: 12, weight: .semibold)).foregroundStyle(ZColor.coral)
                    Button("重新准备") { Task { await service.retry() } }
                        .buttonStyle(.plain).font(.system(size: 12, weight: .bold))
                        .foregroundStyle(ZColor.acid)
                        .accessibilityLabel("重新准备后台服务")
                }
            }
            PrimaryButton("继续", disabled: !service.isReady) {
                model.onboarding.step = 1
            }
        }
    }
}

private struct AgentStep: View {
    let model: AppModel
    @ObservedObject private var service: ServiceController

    init(model: AppModel) {
        self.model = model
        _service = ObservedObject(wrappedValue: model.service)
    }

    private var allReady: Bool {
        groups.allSatisfy { _, values in
            !values.isEmpty && values.allSatisfy(\.isReady)
        }
    }

    private var groups: [(String, [IntegrationStatus])] {
        let values = service.status?.integrations ?? []
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
            BackButton { model.onboarding.step = 0 }
            Button("稍后设置") { model.onboarding.step = 2 }
                .buttonStyle(.plain)
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(ZColor.muted)
                .accessibilityLabel("稍后设置 Agent")
            Spacer()
            OperationIssueView(issue: service.integrationIssue)
                .frame(width: 160, height: 38, alignment: .trailing)
            if allReady {
                Color.clear.frame(width: 109, height: 40).accessibilityHidden(true)
            } else {
                SecondaryButton(service.integrationBusy ? "正在连接…" : "一键连接", disabled: service.integrationBusy) {
                    Task { await service.installIntegration("all") }
                }
            }
            PrimaryButton("继续", disabled: service.integrationBusy) {
                model.onboarding.step = 2
            }
        }
        .task {
            _ = await service.refreshStatus()
        }
    }
}

private struct PhoneStep: View {
    let model: AppModel
    @ObservedObject private var service: ServiceController

    init(model: AppModel) {
        self.model = model
        _service = ObservedObject(wrappedValue: model.service)
    }

    private var isPaired: Bool {
        (service.status?.pairedDeviceCount ?? 0) > 0
    }

    private var usesLocalPairing: Bool {
        service.pairing?.transport == .lan
    }

    private var pairingInstructions: String {
        if isPaired {
            if usesLocalPairing {
                return "已通过本地网络安全配对。当前请保持 iPhone 与 Mac 连接同一 Wi-Fi。"
            }
            return "这台 iPhone 已安全配对。离开当前 Wi-Fi 后，Zimlo 会自动切换到加密云连接。"
        }
        if usesLocalPairing {
            return "云端暂不可用，已切换到本地配对。请让 iPhone 与 Mac 连接同一 Wi-Fi 后扫码。"
        }
        return "打开 iPhone 上的 Zimlo 扫描二维码。手机和 Mac 不需要连接同一个 Wi-Fi。"
    }

    var body: some View {
        StepShell {
            HStack(alignment: .top, spacing: 24) {
                VStack(alignment: .leading, spacing: 16) {
                    Text(isPaired ? "手机已经连接" : "把 Zimlo 带到手机")
                        .font(.system(size: 29, weight: .black, design: .rounded))
                        .lineLimit(1)
                        .minimumScaleFactor(0.82)
                    Text(pairingInstructions)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(ZColor.muted)
                        .lineSpacing(4)
                    if isPaired {
                        Label("配对密钥只保存在你的设备上", systemImage: "checkmark.shield")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(ZColor.muted)
                    } else {
                        Label("二维码 2 分钟后自动失效", systemImage: "timer")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(ZColor.muted)
                        Label(usesLocalPairing ? "本地加密直连" : "云端只转发加密连接", systemImage: "lock.shield")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(ZColor.muted)
                    }
                }
                Spacer()
                PairingCard(service: service, isPaired: isPaired)
            }
        } footer: {
            BackButton { model.onboarding.step = 1 }
            Button("暂不连接手机") { model.onboarding.step = 3 }
                .buttonStyle(.plain)
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(ZColor.muted)
                .accessibilityLabel("暂不连接手机")
            Spacer()
            PrimaryButton(isPaired ? "继续" : "等待手机连接", disabled: !isPaired) {
                model.onboarding.step = 3
            }
        }
        .task(id: service.state) {
            guard PairingAutostartPolicy.shouldCreate(
                serviceState: service.state,
                hasPairing: service.pairing != nil,
                isPaired: isPaired
            ) else { return }
            await service.createPairing()
        }
        .task {
            while !Task.isCancelled && !isPaired {
                try? await Task.sleep(for: .seconds(3))
                guard !Task.isCancelled else { return }
                _ = await service.refreshStatus()
            }
        }
    }
}

private struct CompleteStep: View {
    let model: AppModel
    @ObservedObject private var service: ServiceController
    @State private var finishing = false

    init(model: AppModel) {
        self.model = model
        _service = ObservedObject(wrappedValue: model.service)
    }

    private var canFinish: Bool {
        OnboardingCompletionGate.canFinish(service.state)
    }

    private var isTransitioning: Bool {
        switch service.state {
        case .starting, .stopping: true
        case .ready, .degraded, .manualStopped, .unavailable: false
        }
    }

    private var statusMessage: String {
        switch service.state {
        case .ready:
            service.completionSummary
        case .starting:
            service.runtimePreparationMessage
                ?? "正在确认本地 Bridge 和协议状态，确认完成后才能结束设置。"
        case .stopping:
            "后台服务正在停止。请重新启动服务并通过检查后再完成设置。"
        case .manualStopped:
            "后台服务已手动停止。启动并确认服务正常后，手机才能继续接收任务。"
        case .degraded(let message), .unavailable(let message):
            message
        }
    }

    var body: some View {
        StepShell {
            Spacer()
            ZStack {
                Circle()
                    .fill(canFinish ? ZColor.acidSoft : ZColor.coralSoft)
                    .frame(width: 76, height: 76)
                Image(systemName: canFinish ? "checkmark" : "exclamationmark")
                    .font(.system(size: 29, weight: .black))
                    .foregroundStyle(canFinish ? ZColor.acid : ZColor.coral)
            }
            Text(canFinish ? "Zimlo 已经准备好了" : "后台服务还没准备好")
                .font(.system(size: 34, weight: .black, design: .rounded))
            Text(statusMessage)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(canFinish ? ZColor.muted : ZColor.coral)
                .multilineTextAlignment(.center)
                .lineSpacing(4)
                .frame(maxWidth: 430)
            Spacer()
        } footer: {
            BackButton { model.onboarding.step = 2 }
            SecondaryButton("打开控制台", disabled: !service.isReady) {
                WindowCoordinator.shared.showMainApp()
            }
            Spacer()
            if !canFinish {
                SecondaryButton(
                    service.controlBusy || isTransitioning ? "正在检查…" : "重新检查",
                    disabled: service.controlBusy || isTransitioning
                ) {
                    Task { await service.retry() }
                }
            }
            PrimaryButton(finishing ? "正在确认…" : "完成", disabled: !canFinish || finishing) {
                finishing = true
                Task {
                    guard await service.verifyReady() else {
                        finishing = false
                        return
                    }
                    model.onboarding.finish()
                    WindowCoordinator.shared.closeOnboarding()
                    WindowCoordinator.shared.showMainApp()
                    _ = await MacNotificationManager.shared.requestAuthorizationIfNeeded()
                    finishing = false
                }
            }
        }
        .task {
            _ = await service.verifyReady()
        }
    }
}

enum OnboardingCompletionGate {
    static func canFinish(_ state: ServiceState) -> Bool {
        state == .ready
    }
}

struct MenuPanel: View {
    let model: AppModel
    @ObservedObject private var service: ServiceController
    @State private var launchAtLogin = SMAppService.mainApp.status == .enabled
    @State private var menuNotice: String?

    init(model: AppModel) {
        self.model = model
        _service = ObservedObject(wrappedValue: model.service)
    }

    private var subtitle: String {
        switch service.state {
        case .ready: "后台服务正常"
        case .starting: "正在准备后台服务"
        case .stopping: "正在停止后台服务"
        case .degraded: "连接不稳定"
        case .manualStopped: "已手动停止"
        case .unavailable: "需要修复"
        }
    }

    private var detail: String {
        service.state.recoveryMessage ?? menuNotice ?? service.menuDetail
    }

    private var detailColor: Color {
        if menuNotice != nil { return ZColor.warning }
        switch service.state {
        case .ready, .manualStopped: return ZColor.muted
        case .starting, .stopping: return ZColor.warning
        case .degraded, .unavailable: return ZColor.coral
        }
    }

    private var statusColor: Color {
        switch service.state {
        case .ready: ZColor.acid
        case .starting, .stopping: ZColor.warning
        case .degraded: ZColor.warning
        case .manualStopped: ZColor.muted
        case .unavailable: ZColor.coral
        }
    }

    private var detailSymbol: String {
        menuNotice == nil ? service.menuBarSymbol : "info.circle.fill"
    }

    @ViewBuilder
    private var serviceControl: some View {
        switch service.state {
        case .ready:
            EmptyView()
        case .manualStopped:
            MenuAction(
                icon: "play.circle",
                label: service.controlBusy ? "正在启动服务…" : "启动后台服务",
                trailingIcon: nil,
                disabled: service.controlBusy
            ) {
                Task { await service.retry() }
            }
        case .starting, .stopping:
            EmptyView()
        case .degraded, .unavailable:
            MenuAction(
                icon: "arrow.clockwise",
                label: service.controlBusy ? "正在重新检查…" : "重新检查服务",
                trailingIcon: nil,
                disabled: service.controlBusy
            ) {
                Task { await service.retry() }
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                ZimloMark(size: 38)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Zimlo")
                        .font(.system(size: 15, weight: .black, design: .rounded))
                        .foregroundStyle(ZColor.ink)
                    Text(subtitle)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(ZColor.muted)
                }
                Spacer()
                Circle()
                    .fill(statusColor)
                    .frame(width: 10, height: 10)
                    .overlay(Circle().stroke(Color.white.opacity(0.16), lineWidth: 1))
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 18)
            .padding(.top, 16)
            .padding(.bottom, 8)

            HStack(spacing: 9) {
                Image(systemName: detailSymbol)
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(menuNotice == nil ? statusColor : detailColor)
                    .frame(width: 16)
                Text(detail)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(detailColor)
                    .lineLimit(2)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 11)
            .padding(.vertical, 10)
            .background(ZColor.surface)
            .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .stroke(ZColor.border, lineWidth: 1)
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 12)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("服务详情：\(detail)")

            ZDivider()

            VStack(spacing: 4) {
                serviceControl
                MenuAction(
                    icon: "rectangle.stack",
                    label: "打开 Zimlo",
                    trailingIcon: nil,
                    disabled: !service.isReady
                ) {
                    WindowCoordinator.shared.showMainAppFromMenu()
                }
                MenuAction(icon: "qrcode", label: "连接手机") {
                    model.onboarding.step = 2
                    WindowCoordinator.shared.showOnboardingFromMenu()
                }
                MenuAction(icon: "wand.and.stars", label: "设置 Agent") {
                    model.onboarding.step = 1
                    WindowCoordinator.shared.showOnboardingFromMenu()
                }
            }
            .padding(10)

            ZDivider()

            VStack(spacing: 4) {
                MenuAction(icon: "arrow.triangle.2.circlepath", label: "检查更新", trailingIcon: nil) {
                    if !model.updates.checkForUpdates() {
                        menuNotice = "当前是本地开发版；发布版会在这里检查更新"
                    }
                }
                MenuAction(icon: "doc.text.magnifyingglass", label: "查看日志", trailingIcon: "arrow.up.right") {
                    service.openLog()
                }
            }
            .padding(10)

            ZDivider()

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
                updateLaunchAtLogin(enabled)
            }

            ZDivider()

            HStack {
                Button("退出 Zimlo") { NSApp.terminate(nil) }
                    .buttonStyle(.plain)
                    .foregroundStyle(ZColor.ink)
                    .accessibilityLabel("退出 Zimlo")
                Spacer()
                Text(AppVersion.display).foregroundStyle(ZColor.muted)
            }
            .font(.system(size: 12, weight: .semibold))
            .padding(16)
        }
        .frame(width: 310)
        .foregroundStyle(ZColor.ink)
        .background(ZColor.sidebar)
        .overlay(Rectangle().stroke(ZColor.border, lineWidth: 1))
        .preferredColorScheme(.dark)
        .onAppear {
            synchronizeLaunchAtLogin()
        }
        .task {
            guard service.state != .manualStopped else { return }
            _ = await service.refreshStatus()
        }
    }

    private func synchronizeLaunchAtLogin() {
        let status = SMAppService.mainApp.status
        launchAtLogin = status == .enabled
        if status == .requiresApproval {
            menuNotice = "需要在“系统设置 > 通用 > 登录项”中允许 Zimlo。"
        } else {
            menuNotice = nil
        }
    }

    private func updateLaunchAtLogin(_ enabled: Bool) {
        let current = SMAppService.mainApp.status == .enabled
        guard enabled != current else { return }
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            menuNotice = nil
        } catch {
            menuNotice = enabled
                ? "无法启用登录启动；请在“系统设置 > 通用 > 登录项”中允许 Zimlo。"
                : "无法关闭登录启动；请在系统设置中重试。"
            launchAtLogin = SMAppService.mainApp.status == .enabled
            return
        }
        synchronizeLaunchAtLogin()
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

            ZDivider()
            HStack(spacing: 12) {
                footer
            }
            .padding(.horizontal, 28)
            .frame(height: 78)
            .background(ZColor.sidebar.opacity(0.72))
        }
        .foregroundStyle(ZColor.ink)
        .background(ZColor.paper)
    }
}

private struct ZDivider: View {
    var body: some View {
        Rectangle()
            .fill(ZColor.divider)
            .frame(height: 1)
            .accessibilityHidden(true)
    }
}

private struct PairingCard: View {
    @ObservedObject var service: ServiceController
    let isPaired: Bool
    @State private var copiedPairingLink: String?

    var body: some View {
        VStack(spacing: 13) {
            ZStack {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(ZColor.surfaceRaised)
                if isPaired {
                    VStack(spacing: 12) {
                        ZStack {
                            Circle().fill(ZColor.acidSoft).frame(width: 68, height: 68)
                            Image(systemName: "checkmark")
                                .font(.system(size: 28, weight: .black))
                                .foregroundStyle(ZColor.acid)
                        }
                        Text("iPhone 已连接")
                            .font(.system(size: 13, weight: .black))
                            .foregroundStyle(ZColor.ink)
                    }
                } else if let image = service.pairingImage {
                    ZStack {
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .fill(ZColor.qrPaper)
                            .padding(9)
                        Image(nsImage: image)
                            .resizable()
                            .interpolation(.none)
                            .scaledToFit()
                            .padding(16)
                            .accessibilityLabel("用于连接 iPhone 的 Zimlo 二维码")
                    }
                } else if service.pairingBusy || service.state == .starting {
                    ProgressView(service.pairingBusy ? "正在生成二维码" : "正在准备后台服务")
                        .controlSize(.large)
                        .tint(ZColor.acid)
                } else {
                    Image(systemName: "wifi.exclamationmark")
                        .font(.system(size: 28, weight: .medium))
                        .foregroundStyle(ZColor.muted)
                        .accessibilityLabel("二维码暂不可用")
                }

                if service.pairingBusy, service.pairingImage != nil {
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .fill(ZColor.surfaceRaised.opacity(0.88))
                    ProgressView().controlSize(.large).tint(ZColor.acid)
                        .accessibilityLabel("正在刷新二维码")
                }
            }
            .frame(width: 206, height: 206)
            .overlay(RoundedRectangle(cornerRadius: 20).stroke(ZColor.border))

            Group {
                if !isPaired, let expiresAt = service.pairing?.expiresAtDate {
                    PairingExpiryStatus(expiresAt: expiresAt)
                } else {
                    Color.clear
                }
            }
            .frame(height: 18)

            if !isPaired {
                OperationIssueView(issue: service.pairingIssue, alignment: .center)
                    .frame(width: 218, height: 34)
                VStack(spacing: 8) {
                    HStack(spacing: 8) {
                        copyButton(
                            id: "default",
                            title: service.pairing?.localPairUrl == nil ? "复制连接码" : "复制通用码",
                            link: service.pairing?.pairUrl
                        )
                        if let localPairUrl = service.pairing?.localPairUrl {
                            copyButton(id: "local", title: "复制本地码", link: localPairUrl)
                        }
                    }
                    refreshPairingButton
                    if service.pairing?.localPairUrl != nil {
                        Text("模拟器或同一 Wi-Fi 请使用本地码")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(ZColor.muted)
                    }
                }
                .frame(width: 250)
            }
        }
        .task(id: service.pairing?.expiresAt) {
            guard !isPaired,
                  let pairing = service.pairing,
                  let expiresAt = pairing.expiresAtDate else { return }
            let wait = max(0, expiresAt.timeIntervalSinceNow)
            try? await Task.sleep(for: .seconds(wait))
            guard !Task.isCancelled,
                  service.pairing?.expiresAt == pairing.expiresAt,
                  !isPaired else { return }
            await service.createPairing()
        }
    }

    private func copyButton(id: String, title: String, link: String?) -> some View {
        SecondaryButton(
            copiedPairingLink == id ? "已复制" : title,
            disabled: link == nil || service.pairingBusy
        ) {
            guard let link else { return }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(link, forType: .string)
            copiedPairingLink = id
            Task {
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled else { return }
                if copiedPairingLink == id { copiedPairingLink = nil }
            }
        }
    }

    private var refreshPairingButton: some View {
        SecondaryButton("刷新二维码", disabled: service.pairingBusy) {
            copiedPairingLink = nil
            Task { await service.createPairing() }
        }
    }
}

private struct PairingExpiryStatus: View {
    let expiresAt: Date

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let remaining = PairingCountdown.remainingSeconds(expiresAt: expiresAt, now: context.date)
            Label(
                remaining > 0 ? "二维码 \(remaining) 秒后失效" : "正在刷新二维码…",
                systemImage: remaining > 0 ? "timer" : "arrow.clockwise"
            )
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(remaining > 0 ? ZColor.muted : ZColor.coral)
            .monospacedDigit()
            .accessibilityLabel(remaining > 0 ? "二维码还有 \(remaining) 秒失效" : "正在刷新二维码")
        }
    }
}

private struct IntegrationCard: View {
    let label: String
    let values: [IntegrationStatus]

    private var connectionState: IntegrationConnectionState {
        guard !values.isEmpty else { return .checking }
        let readyCount = values.filter(\.isReady).count
        if readyCount == values.count { return .ready }
        if readyCount > 0 { return .partial }
        return .available
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
                RoundedRectangle(cornerRadius: 13)
                    .fill(connectionState == .ready ? ZColor.acidSoft : ZColor.surfaceRaised)
                Image(systemName: label == "Codex" ? "chevron.left.forwardslash.chevron.right" : "sparkles")
                    .font(.system(size: 15, weight: .black))
                    .foregroundStyle(connectionState == .ready ? ZColor.acid : ZColor.muted)
            }
            .frame(width: 44, height: 44)
            VStack(alignment: .leading, spacing: 4) {
                Text(label).font(.system(size: 13, weight: .bold))
                Text(detail)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(ZColor.muted)
                    .lineLimit(2)
            }
            Spacer()
            Text(connectionState.label)
                .font(.system(size: 12, weight: .black))
                .padding(.horizontal, 9)
                .padding(.vertical, 6)
                .foregroundStyle(connectionState == .ready ? ZColor.acid : ZColor.muted)
                .background(connectionState == .ready ? ZColor.acidSoft : ZColor.surfaceRaised)
                .clipShape(Capsule())
        }
        .padding(15)
        .background(ZColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(ZColor.border))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label)：\(connectionState.label)。\(detail)")
    }
}

private enum IntegrationConnectionState {
    case checking
    case available
    case partial
    case ready

    var label: String {
        switch self {
        case .checking: "检查中"
        case .available: "尚未连接"
        case .partial: "部分连接"
        case .ready: "已连接"
        }
    }
}

private struct ZimloMark: View {
    let size: CGFloat

    var body: some View {
        Image(nsImage: NSApplication.shared.applicationIconImage)
            .resizable()
            .interpolation(.high)
            .antialiased(true)
            .scaledToFit()
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

private struct StatusPill: View {
    let label: String
    let ready: Bool

    var body: some View {
        HStack(spacing: 7) {
            Circle().fill(ready ? ZColor.acid : ZColor.warning).frame(width: 7, height: 7)
            Text(label.uppercased())
                .font(.system(size: 12, weight: .black, design: .monospaced))
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 7)
        .background(ZColor.surfaceRaised)
        .foregroundStyle(ZColor.ink)
        .clipShape(Capsule())
        .overlay(Capsule().stroke(ZColor.border))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("后台服务：\(label)")
    }
}

private struct ValueChip: View {
    let icon: String
    let text: String

    var body: some View {
        Label(text, systemImage: icon)
            .font(.system(size: 12, weight: .bold))
            .padding(.horizontal, 11)
            .padding(.vertical, 8)
            .foregroundStyle(ZColor.muted)
            .background(ZColor.surface)
            .clipShape(Capsule())
            .overlay(Capsule().stroke(ZColor.border))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(text)
    }
}

private struct PrimaryButton: View {
    let label: String
    let disabled: Bool
    let action: () -> Void
    @State private var isHovering = false

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
            .foregroundStyle(disabled ? ZColor.subtle : ZColor.onAccent)
            .background(disabled ? ZColor.surfaceRaised : ZColor.acid.opacity(isHovering ? 0.88 : 1))
            .clipShape(Capsule())
            .overlay(Capsule().stroke(disabled ? ZColor.border : ZColor.acid.opacity(0.55)))
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .keyboardShortcut(.defaultAction)
        .accessibilityLabel(label)
        .onHover { isHovering = $0 }
    }
}

private struct SecondaryButton: View {
    let label: String
    let disabled: Bool
    let action: () -> Void
    @State private var isHovering = false

    init(_ label: String, disabled: Bool = false, action: @escaping () -> Void) {
        self.label = label
        self.disabled = disabled
        self.action = action
    }

    var body: some View {
        Button(label, action: action)
            .buttonStyle(.plain)
            .font(.system(size: 12, weight: .bold))
            .padding(.horizontal, 17)
            .frame(height: 40)
            .foregroundStyle(disabled ? ZColor.subtle : ZColor.ink)
            .background(isHovering && !disabled ? ZColor.surfaceHover : ZColor.surfaceRaised)
            .clipShape(Capsule())
            .overlay(Capsule().stroke(ZColor.border))
            .disabled(disabled)
            .accessibilityLabel(label)
            .onHover { isHovering = $0 }
    }
}

private struct BackButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label("返回", systemImage: "chevron.left")
                .font(.system(size: 12, weight: .bold))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(ZColor.muted)
        .keyboardShortcut(.cancelAction)
        .accessibilityLabel("返回上一步")
    }
}

private struct OperationIssueView: View {
    let issue: OperationIssue?
    var alignment: TextAlignment = .trailing

    var body: some View {
        Group {
            if let issue {
                VStack(alignment: alignment == .center ? .center : .trailing, spacing: 1) {
                    Text(issue.message)
                    if let action = issue.action {
                        Text(action).foregroundStyle(ZColor.muted)
                    }
                }
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(ZColor.coral)
                .lineLimit(2)
                .multilineTextAlignment(alignment)
                .accessibilityElement(children: .combine)
            } else {
                Color.clear.accessibilityHidden(true)
            }
        }
    }
}

private struct MenuAction: View {
    let icon: String
    let label: String
    let trailingIcon: String?
    let disabled: Bool
    let action: () -> Void
    @State private var isHovering = false

    init(
        icon: String,
        label: String,
        trailingIcon: String? = "chevron.right",
        disabled: Bool = false,
        action: @escaping () -> Void
    ) {
        self.icon = icon
        self.label = label
        self.trailingIcon = trailingIcon
        self.disabled = disabled
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .frame(width: 18)
                    .foregroundStyle(disabled ? ZColor.subtle : ZColor.muted)
                Text(label)
                    .foregroundStyle(disabled ? ZColor.subtle : ZColor.ink)
                Spacer()
                if let trailingIcon {
                    Image(systemName: trailingIcon)
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(ZColor.muted)
                }
            }
            .font(.system(size: 12, weight: .semibold))
            .contentShape(Rectangle())
            .padding(.horizontal, 8)
            .frame(height: 38)
            .background(isHovering && !disabled ? ZColor.surfaceHover : .clear)
            .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.48 : 1)
        .accessibilityLabel(label)
        .onHover { isHovering = $0 }
    }
}
