import SwiftUI

enum PhoneSetupRoot: Equatable {
    case firstRun
    case appShell
}

enum PhoneSetupRules {
    static let dismissedKey = "zimlo.phone-setup.dismissed.v1"
    static let hasEverPairedKey = "zimlo.phone-setup.has-ever-paired.v1"
    static let macDownloadURL = URL(
        string: "https://cloud.zimlo.app/releases/macos/download"
    )!

    static func root(
        pairingRequired: Bool,
        hasEverPaired: Bool,
        dismissed: Bool
    ) -> PhoneSetupRoot {
        pairingRequired && !hasEverPaired && !dismissed ? .firstRun : .appShell
    }
}

enum PhoneSetupStep {
    case introduction
    case pairing
}

struct PhoneSetupIntroView: View {
    let returningUser: Bool
    let showsCloseButton: Bool
    let onDismiss: () -> Void
    let onReadyToPair: () -> Void

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(spacing: 0) {
                    HStack {
                        Spacer()
                        Button(showsCloseButton ? "关闭" : "稍后", action: onDismiss)
                            .font(ZFont.subheadline.weight(.bold))
                            .foregroundStyle(ZColor.muted)
                            .frame(minWidth: 44, minHeight: 44)
                            .accessibilityHint(showsCloseButton ? "返回 Zimlo" : "稍后可从 Feed 重新连接运行设备")
                    }

                    ZimloAvatar(size: dynamicTypeSize.isAccessibilitySize ? 64 : 72)
                        .padding(.top, dynamicTypeSize.isAccessibilitySize ? 8 : 24)
                        .accessibilityHidden(true)

                    VStack(spacing: 10) {
                        Text(returningUser ? "重新连接运行设备" : "先连接运行设备")
                            .font(ZFont.title)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                        Text("在 Mac 或 Linux 服务器启动 Zimlo，接入 Codex 或 Claude Code，然后用手机扫码。大约需要 2 分钟。")
                            .font(ZFont.subheadline)
                            .foregroundStyle(ZColor.muted)
                            .multilineTextAlignment(.center)
                            .lineSpacing(3)
                            .frame(maxWidth: 340)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.top, 18)

                    VStack(spacing: 0) {
                        setupRow(icon: "terminal", title: "不需要终端", detail: "Mac App 会自动准备后台服务")
                        Divider().overlay(ZColor.line).padding(.leading, 52)
                        setupRow(icon: "wifi", title: "无需同一 Wi-Fi", detail: "配对后自动使用加密远程连接")
                        Divider().overlay(ZColor.line).padding(.leading, 52)
                        setupRow(icon: "lock.shield", title: "端到端加密", detail: "任务正文和代码不会存进云端")
                    }
                    .background(ZColor.raised)
                    .overlay(RoundedRectangle(cornerRadius: ZRadius.inner).stroke(ZColor.line))
                    .clipShape(RoundedRectangle(cornerRadius: ZRadius.inner, style: .continuous))
                    .padding(.top, 28)

                    Spacer(minLength: 30)

                    VStack(spacing: 10) {
                        ShareLink(
                            item: PhoneSetupRules.macDownloadURL,
                            subject: Text("在 Mac 上安装 Zimlo"),
                            message: Text("请在 Mac 打开这个地址安装 Zimlo，然后在电脑上显示配对二维码。")
                        ) {
                            Label("在 Mac 上安装 Zimlo", systemImage: "square.and.arrow.up")
                        }
                        .buttonStyle(PhoneSetupPrimaryButtonStyle())
                        .accessibilityHint("通过 AirDrop、信息或邮件发送 Mac 安装地址")

                        Text("点击后可通过 AirDrop、信息或邮件把安装地址发送到电脑。")
                            .font(ZFont.footnote)
                            .foregroundStyle(ZColor.muted)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)

                        Button("我已经在运行设备启动 Zimlo", action: onReadyToPair)
                            .font(ZFont.callout.weight(.bold))
                            .foregroundStyle(ZColor.ink)
                            .frame(maxWidth: .infinity, minHeight: 50)
                            .background(ZColor.control)
                            .overlay(RoundedRectangle(cornerRadius: ZRadius.control).stroke(ZColor.line))
                            .clipShape(RoundedRectangle(cornerRadius: ZRadius.control, style: .continuous))
                            .accessibilityHint("进入扫码和连接码页面")
                    }
                }
                .frame(maxWidth: 440, minHeight: max(0, geometry.size.height - 48))
                .padding(.horizontal, 24)
                .padding(.vertical, 24)
                .frame(maxWidth: .infinity)
            }
            .scrollIndicators(.hidden)
            .scrollBounceBehavior(.basedOnSize)
            .foregroundStyle(ZColor.ink)
            .background(ZColor.canvas)
        }
        .environment(\.colorScheme, .dark)
    }

    private func setupRow(icon: String, title: String, detail: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(ZFont.body.weight(.semibold))
                .foregroundStyle(ZColor.sageText)
                .frame(width: 28)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(ZFont.subheadline.weight(.bold))
                Text(detail)
                    .font(ZFont.footnote)
                    .foregroundStyle(ZColor.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 13)
        .accessibilityElement(children: .combine)
    }
}

struct MacConnectionEmptyView: View {
    let returningUser: Bool
    let onConnect: () -> Void

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(spacing: 0) {
                    Spacer(minLength: 32)
                    Image(systemName: returningUser ? "desktopcomputer.trianglebadge.exclamationmark" : "desktopcomputer")
                        .font(.system(size: dynamicTypeSize.isAccessibilitySize ? 42 : 50, weight: .medium))
                        .foregroundStyle(ZColor.sageText)
                        .frame(width: 88, height: 88)
                        .background(ZColor.raised)
                        .clipShape(Circle())
                        .accessibilityHidden(true)
                    Text(returningUser ? "没有已连接的运行设备" : "还没有连接运行设备")
                        .font(ZFont.title2)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 22)
                    Text(returningUser
                         ? "重新连接运行 Codex 或 Claude Code 的电脑后，任务会继续出现在这里。"
                         : "连接运行 Codex 或 Claude Code 的电脑后，任务结果、回复和审批会出现在这里。")
                        .font(ZFont.subheadline)
                        .foregroundStyle(ZColor.muted)
                        .multilineTextAlignment(.center)
                        .lineSpacing(3)
                        .frame(maxWidth: 330)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 10)
                    Button(returningUser ? "重新连接运行设备" : "连接运行设备", action: onConnect)
                        .buttonStyle(PhoneSetupPrimaryButtonStyle())
                        .padding(.top, 26)
                        .frame(maxWidth: 360)
                    Text("运行设备暂时离线时不会进入这个页面，最近内容仍会保留。")
                        .font(ZFont.footnote)
                        .foregroundStyle(ZColor.muted)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 14)
                    Spacer(minLength: 32)
                }
                .frame(maxWidth: .infinity, minHeight: geometry.size.height)
                .padding(.horizontal, 28)
            }
            .scrollIndicators(.hidden)
            .scrollBounceBehavior(.basedOnSize)
        }
        .foregroundStyle(ZColor.ink)
        .background(ZColor.paper)
        .environment(\.colorScheme, .dark)
    }
}

private struct PhoneSetupPrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(ZFont.callout.weight(.black))
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, minHeight: 50)
            .padding(.horizontal, 16)
            .foregroundStyle(ZColor.onAccent.opacity(isEnabled ? 1 : 0.55))
            .background(ZColor.acid.opacity(isEnabled ? 1 : 0.36))
            .clipShape(RoundedRectangle(cornerRadius: ZRadius.control, style: .continuous))
            .opacity(configuration.isPressed ? 0.72 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

#Preview("首次连接 Mac") {
    PhoneSetupIntroView(
        returningUser: false,
        showsCloseButton: false,
        onDismiss: {},
        onReadyToPair: {}
    )
    .preferredColorScheme(.dark)
}

#Preview("移除最后一台 Mac 后") {
    MacConnectionEmptyView(returningUser: true, onConnect: {})
        .preferredColorScheme(.dark)
}
