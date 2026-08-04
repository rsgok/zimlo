import SwiftUI
import UIKit

enum ZColor {
    // Native dark hierarchy: canvas < page/card < raised content < controls.
    static let canvas = Color(red: 0.025, green: 0.029, blue: 0.026)
    static let paper = Color(red: 0.045, green: 0.052, blue: 0.047)
    static let raised = Color(red: 0.085, green: 0.098, blue: 0.090)
    static let control = Color(red: 0.120, green: 0.137, blue: 0.125)
    static let ink = Color(red: 0.940, green: 0.925, blue: 0.880)
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
        let base64 = provider == .codex
            ? "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"
            : "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"
        guard let decoded = Data(base64Encoded: base64).flatMap(UIImage.init(data:)) else { return nil }
        Self.cache.setObject(decoded, forKey: key)
        return decoded
    }

    var body: some View {
        Group {
            if let image {
                // Codex artwork is a full-colour, fully opaque PNG; template
                // rendering turns its whole 32×32 alpha plane into a blank
                // square. Claude is a transparent monochrome mark and remains
                // template-tinted for dark-mode contrast.
                Image(uiImage: image)
                    .renderingMode(provider == .codex ? .original : .template)
                    .resizable()
                    .scaledToFit()
            } else {
                Text(provider == .codex ? "C" : "A").font(.system(size: size, weight: .black))
            }
        }
        .foregroundStyle(ZColor.ink)
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: provider == .codex ? size * 0.5 : size * 0.22, style: .continuous))
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
            .frame(width: size, height: size)
            .clipShape(Circle())
            .overlay(Circle().stroke(ZColor.ink.opacity(0.22), lineWidth: 1))
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
    var onRetry: (() -> Void)?

    static func contentHeight(for size: DynamicTypeSize) -> CGFloat {
        size.isAccessibilitySize ? 52 : 44
    }

    var body: some View {
        ZStack {
            Text(title)
                .font(ZFont.subheadline.weight(.bold))
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
                    Text(status)
                        .font(ZFont.caption2)
                        .padding(.horizontal, 9).padding(.vertical, 6)
                        .background(ZColor.raised)
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
