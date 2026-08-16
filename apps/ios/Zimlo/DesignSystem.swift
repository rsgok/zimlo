import SwiftUI
import UIKit

enum ZColor {
    // Native dark hierarchy: canvas < page/card < raised content < controls.
    static let canvas = Color(red: 0.025, green: 0.029, blue: 0.026)
    static let paper = Color(red: 0.045, green: 0.052, blue: 0.047)
    static let raised = Color(red: 0.085, green: 0.098, blue: 0.090)
    static let control = Color(red: 0.120, green: 0.137, blue: 0.125)
    static let ink = Color(red: 0.940, green: 0.925, blue: 0.880)
    static let secondaryInk = Color(red: 0.720, green: 0.710, blue: 0.670)
    static let muted = Color(red: 0.550, green: 0.570, blue: 0.540)

    // Muted moss accent: reserved for selection and the primary next action.
    static let acid = Color(red: 0.440, green: 0.580, blue: 0.310)
    static let onAccent = Color(red: 0.035, green: 0.055, blue: 0.030)
    static let sage = Color(red: 0.380, green: 0.570, blue: 0.380)
    static let sageText = Color(red: 0.630, green: 0.820, blue: 0.600)
    // Dark enough for warm-white copy to retain >= 4.5:1 on solid danger fills.
    static let coral = Color(red: 0.660, green: 0.250, blue: 0.220)
    static let coralText = Color(red: 0.950, green: 0.590, blue: 0.520)
    static let line = ink.opacity(0.12)
}

// 语义字体：映射系统 text style，天然支持 Dynamic Type。正文与标题一律从这里取，
// 不再手写 point size（历史遗留的小字号徽标除外）。
enum ZFont {
    static let hero = Font.system(.largeTitle, design: .rounded).weight(.black)
    static let title = Font.title.weight(.black)
    static let title2 = Font.title2.weight(.black)
    static let title3 = Font.title3.weight(.black)
    static let headline = Font.headline
    static let body = Font.body
    static let callout = Font.callout
    static let subheadline = Font.subheadline
    static let footnote = Font.footnote
    static let caption = Font.caption.weight(.bold)
    static let caption2 = Font.caption2.weight(.bold)
}

enum ZRadius {
    static let card: CGFloat = 30
    static let sheet: CGFloat = 28
    static let inner: CGFloat = 15
    static let control: CGFloat = 14
    static let small: CGFloat = 11
}

struct ProviderIcon: View {
    let provider: Provider
    var size: CGFloat = 14

    private static let cache = NSCache<NSString, UIImage>()

    private var image: UIImage? {
        let key = provider.rawValue as NSString
        if let cached = Self.cache.object(forKey: key) { return cached }
        guard let url = Bundle.main.url(
            forResource: provider.rawValue,
            withExtension: "png",
            subdirectory: "providers"
        ), let decoded = UIImage(contentsOfFile: url.path) else { return nil }
        Self.cache.setObject(decoded, forKey: key)
        return decoded
    }

    var body: some View {
        Group {
            if let image {
                // Codex artwork is a full-colour, fully opaque PNG; template
                // rendering turns its whole alpha plane into a blank
                // square. Claude is a transparent monochrome mark and remains
                // template-tinted for dark-mode contrast.
                Image(uiImage: image)
                    .renderingMode(.original)
                    .resizable()
                    .scaledToFit()
            } else {
                Text(provider == .codex ? "C" : "A").font(.system(size: size, weight: .black))
            }
        }
        .foregroundStyle(ZColor.ink)
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
        .accessibilityHidden(true)
    }
}

struct ProviderBadge: View {
    let provider: Provider
    var surface: String?
    var iconOnly = false

    private var surfaceLabel: String? {
        switch surface {
        case "gui": "GUI"
        case "cli": "CLI"
        case "managed": "Zimlo"
        case .some: "Runtime"
        case nil: nil
        }
    }

    var body: some View {
        HStack(spacing: 5) {
            ProviderIcon(provider: provider)
            if !iconOnly, let surfaceLabel {
                Text(surfaceLabel).font(ZFont.caption2.monospaced().weight(.bold))
            }
        }
        .padding(.horizontal, iconOnly ? 6 : 7).padding(.vertical, 5)
        .background(ZColor.raised)
        .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(ZColor.line))
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(surfaceLabel.map { "\(provider.label) · \($0)" } ?? provider.label)
    }
}

struct ZimloAvatar: View {
    var size: CGFloat = 34

    var body: some View {
        BundleImage(name: "zimlo")
            .frame(width: size, height: size)
            .clipShape(Circle())
    }
}

struct UserAvatar: View {
    let id: String
    var size: CGFloat = 38

    var body: some View {
        BundleImage(name: id)
            .frame(width: size * 1.14, height: size * 1.14)
            .frame(width: size, height: size)
            .clipShape(Circle())
            .overlay(Circle().stroke(ZColor.ink.opacity(0.14), lineWidth: 0.5))
    }
}

struct AgentAvatar: View {
    let value: String
    var size: CGFloat = 38

    private var isPreset: Bool {
        guard value.hasPrefix("user-"),
              let number = Int(value.dropFirst("user-".count)) else { return false }
        return (1...24).contains(number) && value == String(format: "user-%02d", number)
    }

    var body: some View {
        Group {
            if isPreset {
                UserAvatar(id: value, size: size)
            } else {
                Text(value)
                    .font(.system(size: size * 0.45, weight: .bold))
                    .frame(width: size, height: size)
                    .background(ZColor.control)
                    .clipShape(Circle())
            }
        }
    }
}

struct BundleImage: View {
    let name: String

    private static let cache = NSCache<NSString, UIImage>()

    private var image: UIImage? {
        let key = name as NSString
        if let cached = Self.cache.object(forKey: key) { return cached }
        guard let url = Bundle.main.url(forResource: name, withExtension: "png", subdirectory: "avatars"),
              let decoded = UIImage(contentsOfFile: url.path) else { return nil }
        Self.cache.setObject(decoded, forKey: key)
        return decoded
    }

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                ZColor.raised.overlay(Text(name == "zimlo" ? "Z" : "•").font(.headline).foregroundStyle(ZColor.ink))
            }
        }
    }
}

struct AppTopBar: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let title: String
    let connected: Bool
    var connectionLabel: String?
    var onBack: (() -> Void)?
    var status: String?
    var statusColor: Color?
    var onRetry: (() -> Void)?

    static func contentHeight(for size: DynamicTypeSize) -> CGFloat {
        size.isAccessibilitySize ? 52 : 44
    }

    var body: some View {
        ZStack {
            Text(title)
                .font(ZFont.headline.weight(.bold))
                .lineLimit(1)
                .padding(.horizontal, 80)
            HStack {
                if let onBack {
                    Button(action: onBack) {
                        Image(systemName: "arrow.left")
                            .font(.body.weight(.semibold))
                            .frame(width: 44, height: 44)
                    }
                } else {
                    ZimloAvatar(size: 30)
                }
                Spacer()
                if let status {
                    let tone = statusColor ?? ZColor.secondaryInk
                    Text(status)
                        .font(ZFont.caption2)
                        .foregroundStyle(tone)
                        .padding(.horizontal, 9).padding(.vertical, 6)
                        .background(tone.opacity(0.14))
                        .overlay(Capsule().stroke(tone.opacity(0.26)))
                        .clipShape(Capsule())
                } else {
                    // 断线时胶囊可点按，立即触发一次重连，不必等退避循环。
                    Button(action: { onRetry?() }) {
                        HStack(spacing: 6) {
                            Circle().fill(connected ? ZColor.sage : Color.orange).frame(width: 6, height: 6)
                            Text(connectionLabel ?? (connected ? "实时" : "点按重连"))
                                .font(ZFont.caption2)
                        }
                    }
                    .disabled(connected || onRetry == nil)
                }
            }
            .padding(.horizontal, 14)
        }
        .foregroundStyle(ZColor.ink)
        .frame(height: Self.contentHeight(for: dynamicTypeSize))
        .background(ZColor.canvas)
    }
}

/// 顶层目录页共享的筛选器。系统 segmented control 在 App 强制深色模式时会
/// 把浅色页面上的文字渲染成白色，改为语义色后可保证所有页面的对比度一致。
struct ZFilterBar: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let options: [String]
    @Binding var selection: String
    let searchExpanded: Bool
    let toggleSearch: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Group {
                if dynamicTypeSize.isAccessibilitySize {
                    ScrollView(.horizontal) {
                        HStack(spacing: 3) {
                            ForEach(options, id: \.self) { option in optionButton(option, equalWidth: false) }
                        }
                        .padding(3)
                    }
                    .scrollIndicators(.hidden)
                    .scrollBounceBehavior(.basedOnSize)
                } else {
                    HStack(spacing: 3) {
                        ForEach(options, id: \.self) { option in optionButton(option, equalWidth: true) }
                    }
                    .padding(3)
                }
            }
            .background(ZColor.control)
            .clipShape(RoundedRectangle(cornerRadius: ZRadius.control, style: .continuous))

            Button(action: toggleSearch) {
                Image(systemName: searchExpanded ? "xmark" : "magnifyingglass")
                    .font(ZFont.body.weight(.semibold))
                    .foregroundStyle(ZColor.ink)
                    .frame(width: 44, height: 44)
                    .background(ZColor.control)
                    .clipShape(RoundedRectangle(cornerRadius: ZRadius.control, style: .continuous))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(searchExpanded ? "关闭搜索" : "搜索")
        }
    }

    private func optionButton(_ option: String, equalWidth: Bool) -> some View {
        Button {
            guard selection != option else { return }
            selection = option
            Haptics.selection()
        } label: {
            Text(option)
                .font(ZFont.caption2)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
                .frame(maxWidth: equalWidth ? .infinity : nil, minHeight: 38)
                .padding(.horizontal, equalWidth ? 4 : 13)
                .foregroundStyle(selection == option ? ZColor.onAccent : ZColor.ink.opacity(0.68))
                .background(selection == option ? ZColor.acid : Color.clear)
                .clipShape(RoundedRectangle(cornerRadius: ZRadius.small, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selection == option ? .isSelected : [])
    }
}

extension View {
    func zCard() -> some View {
        self.background(ZColor.paper)
            .clipShape(RoundedRectangle(cornerRadius: ZRadius.card, style: .continuous))
    }

    /// 页面本身使用满宽 paper；圆角只留给内容卡片。避免顶层页面重复套一张
    /// “悬浮纸片”，在窄屏和 Dynamic Type 下损失可用宽度。
    func zPageSurface() -> some View {
        self
            .foregroundStyle(ZColor.ink)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(ZColor.paper, ignoresSafeAreaEdges: [])
            .environment(\.colorScheme, .dark)
    }
}
