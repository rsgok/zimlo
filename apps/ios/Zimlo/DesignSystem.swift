import SwiftUI

enum ZColor {
    static let ink = Color(red: 0.07, green: 0.08, blue: 0.07)
    static let paper = Color(red: 0.97, green: 0.96, blue: 0.92)
    static let acid = Color(red: 0.78, green: 1.0, blue: 0.22)
    static let coral = Color(red: 0.96, green: 0.43, blue: 0.28)
    static let sage = Color(red: 0.39, green: 0.64, blue: 0.31)
    static let muted = Color(red: 0.42, green: 0.42, blue: 0.38)
    static let line = Color.black.opacity(0.12)
}

struct ZimloAvatar: View {
    var size: CGFloat = 34

    var body: some View {
        BundleImage(name: "zimlo")
            .frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: size * 0.24, style: .continuous))
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

struct PageHeader: View {
    let connected: Bool

    var body: some View {
        HStack {
            HStack(spacing: 10) {
                ZimloAvatar()
                VStack(alignment: .leading, spacing: 0) {
                    Text("Zimlo").font(.system(size: 17, weight: .black, design: .rounded))
                    Text("coding agents, at a glance").font(.system(size: 9, weight: .medium))
                        .foregroundStyle(.white.opacity(0.52))
                }
            }
            Spacer()
            HStack(spacing: 7) {
                Circle().fill(connected ? ZColor.acid : Color.orange).frame(width: 7, height: 7)
                Text(connected ? "实时" : "重连中")
                    .font(.system(size: 12, weight: .semibold))
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .overlay(Capsule().stroke(Color.white.opacity(0.22)))
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 18)
        .frame(height: 58)
        .background(ZColor.ink)
    }
}

extension View {
    func zCard() -> some View {
        self.background(ZColor.paper)
            .clipShape(RoundedRectangle(cornerRadius: 30, style: .continuous))
    }
}
