import SwiftUI
import UIKit

enum ZColor {
    static let ink = Color(red: 0.07, green: 0.08, blue: 0.07)
    static let paper = Color(red: 0.97, green: 0.96, blue: 0.92)
    static let acid = Color(red: 0.78, green: 1.0, blue: 0.22)
    static let coral = Color(red: 0.96, green: 0.43, blue: 0.28)
    static let sage = Color(red: 0.39, green: 0.64, blue: 0.31)
    static let muted = Color(red: 0.42, green: 0.42, blue: 0.38)
    static let line = Color.black.opacity(0.12)
}

struct ProviderIcon: View {
    let provider: Provider
    var size: CGFloat = 14

    private var image: UIImage? {
        let base64 = provider == .codex
            ? "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"
            : "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"
        return Data(base64Encoded: base64).flatMap(UIImage.init(data:))
    }

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFit()
            } else {
                Text(provider == .codex ? "C" : "A").font(.system(size: size, weight: .black))
            }
        }
        .frame(width: size, height: size)
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
                Text(surfaceLabel).font(.system(size: 10, weight: .bold, design: .monospaced))
            }
        }
        .padding(.horizontal, iconOnly ? 6 : 7).padding(.vertical, 5)
        .background(Color.white.opacity(0.62))
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
            .overlay(Circle().stroke(Color.white.opacity(0.22), lineWidth: 1))
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
                    .background(ZColor.acid.opacity(0.35))
                    .clipShape(Circle())
            }
        }
    }
}

struct BundleImage: View {
    let name: String

    var body: some View {
        Group {
            if let url = Bundle.main.url(forResource: name, withExtension: "png", subdirectory: "avatars"),
               let image = UIImage(contentsOfFile: url.path) {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                ZColor.acid.overlay(Text(name == "zimlo" ? "Z" : "•").font(.headline).foregroundStyle(ZColor.ink))
            }
        }
    }
}

struct AppTopBar: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let title: String
    let connected: Bool
    var onBack: (() -> Void)?
    var status: String?

    static func contentHeight(for size: DynamicTypeSize) -> CGFloat {
        size.isAccessibilitySize ? 52 : 44
    }

    var body: some View {
        ZStack {
            Text(title)
                .font(.system(size: 14, weight: .bold))
                .lineLimit(1)
                .padding(.horizontal, 80)
            HStack {
                if let onBack {
                    Button(action: onBack) {
                        Image(systemName: "arrow.left")
                            .font(.system(size: 17, weight: .semibold))
                            .frame(width: 34, height: 34)
                    }
                } else {
                    ZimloAvatar(size: 30)
                }
                Spacer()
                if let status {
                    Text(status)
                        .font(.system(size: 9, weight: .bold))
                        .padding(.horizontal, 9).padding(.vertical, 6)
                        .background(Color.white.opacity(0.1))
                        .clipShape(Capsule())
                } else {
                    HStack(spacing: 6) {
                        Circle().fill(connected ? ZColor.acid : Color.orange).frame(width: 6, height: 6)
                        Text(connected ? "实时" : "重连")
                            .font(.system(size: 10, weight: .semibold))
                    }
                }
            }
            .padding(.horizontal, 14)
        }
        .foregroundStyle(.white)
        .frame(height: Self.contentHeight(for: dynamicTypeSize))
        .background(ZColor.ink)
    }
}

extension View {
    func zCard() -> some View {
        self.background(ZColor.paper)
            .clipShape(RoundedRectangle(cornerRadius: 30, style: .continuous))
    }
}
