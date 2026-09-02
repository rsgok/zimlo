import AppKit
import SwiftUI

enum NativeTheme {
    static let paper = Color(red: 0.045, green: 0.052, blue: 0.049)
    static let surface = Color(red: 0.075, green: 0.087, blue: 0.081)
    static let raised = Color(red: 0.105, green: 0.119, blue: 0.111)
    static let control = Color(red: 0.145, green: 0.158, blue: 0.150)
    static let ink = Color(red: 0.94, green: 0.94, blue: 0.90)
    static let muted = Color(red: 0.57, green: 0.59, blue: 0.55)
    static let acid = Color(red: 0.51, green: 0.68, blue: 0.31)
    static let acidSoft = Color(red: 0.14, green: 0.20, blue: 0.12)
    static let sage = Color(red: 0.49, green: 0.72, blue: 0.48)
    static let coral = Color(red: 0.93, green: 0.47, blue: 0.40)
    static let amber = Color(red: 0.94, green: 0.67, blue: 0.30)
    static let border = Color.white.opacity(0.085)
}

struct NativeSegmentedTabs<Value: Hashable>: View {
    let options: [Value]
    @Binding var selection: Value
    let title: (Value) -> String

    var body: some View {
        HStack(spacing: 3) {
            ForEach(options, id: \.self) { option in
                Button {
                    selection = option
                } label: {
                    Text(title(option))
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(selection == option ? NativeTheme.paper : NativeTheme.ink.opacity(0.72))
                        .padding(.horizontal, 13)
                        .frame(minHeight: 26)
                        .background(selection == option ? NativeTheme.acid : Color.clear)
                        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(title(option))
                .accessibilityAddTraits(selection == option ? .isSelected : [])
            }
        }
        .padding(3)
        .background(NativeTheme.control)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

struct NativeToolbarSearchField: View {
    @Binding var text: String
    let prompt: String
    var width: CGFloat = 252

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(NativeTheme.muted)
            TextField(prompt, text: $text)
                .textFieldStyle(.plain)
                .font(.system(size: 12, weight: .medium))
            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(NativeTheme.muted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("清除搜索")
            }
        }
        .padding(.horizontal, 10)
        .frame(width: width, height: 32)
        .background(NativeTheme.control)
        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .stroke(NativeTheme.border, lineWidth: 1)
        }
    }
}

struct ZimloCardPalette {
    let ink: Color
    let surface: Color
    let accent: Color

    init(theme: String) {
        ink = Color(zimloHex: ZimloCardCatalog.themeInk[theme] ?? "#0A0A0B")
        surface = Color(zimloHex: ZimloCardCatalog.themeSurface[theme] ?? "#F1EFEA")
        accent = Color(zimloHex: ZimloCardCatalog.themeAccent[theme] ?? "#183B34")
    }
}

extension Color {
    init(zimloHex hex: String) {
        let value = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        guard value.count == 6, let raw = UInt64(value, radix: 16) else {
            self = .clear
            return
        }
        self.init(
            red: Double((raw >> 16) & 0xFF) / 255,
            green: Double((raw >> 8) & 0xFF) / 255,
            blue: Double(raw & 0xFF) / 255
        )
    }
}

enum NativeSection: String, CaseIterable, Identifiable {
    case feed
    case tasks
    case agents
    case settings

    var id: String { rawValue }
    var title: String {
        switch self {
        case .feed: "Feed"
        case .tasks: "Tasks"
        case .agents: "Agents"
        case .settings: "设置"
        }
    }
    var subtitle: String {
        switch self {
        case .feed: "值得你看的进展"
        case .tasks: "任务与待办"
        case .agents: "项目里的 Agent"
        case .settings: "连接与权限"
        }
    }
    var symbol: String {
        switch self {
        case .feed: "rectangle.stack.fill"
        case .tasks: "checklist"
        case .agents: "person.2.fill"
        case .settings: "gearshape.fill"
        }
    }
}

enum NativeRoute: Hashable {
    case task(String)
    case agent(String)
}

enum CoreActionState: Equatable {
    case idle
    case active
    case attention
    case offline
    case composing
}

extension NativeSnapshot {
    func project(for session: AgentSession) -> Project? {
        if let projectID = session.projectId,
           let project = projects.first(where: { $0.id == projectID }) {
            return project
        }
        guard let cwd = session.cwd, cwd != "/" else { return nil }
        return projects
            .filter { project in
                guard let sessionHostID = session.hostId,
                      let projectHostID = project.hostId else { return true }
                return sessionHostID == projectHostID
            }
            .filter { project in
                project.paths.contains { path in cwd == path || cwd.hasPrefix(path + "/") }
            }
            .max { $0.primaryPath.count < $1.primaryPath.count }
    }

    func task(for sessionID: String) -> TaskRecord? {
        tasks.filter { $0.sessionId == sessionID }.max { $0.updatedAt < $1.updatedAt }
    }

    func preference(for sessionID: String) -> TaskPreference? {
        taskPreferences.first { $0.sessionId == sessionID }
    }

    func latestPost(for sessionID: String) -> FeedPost? {
        posts.filter { $0.sessionId == sessionID }.max { $0.createdAt < $1.createdAt }
    }

    func pendingAction(for sessionID: String) -> PendingAction? {
        actions.first { $0.sessionId == sessionID && $0.state == "pending" }
    }

    var coreState: CoreActionState {
        let taskStates = Set(tasks.map(\.state))
        if actions.contains(where: { $0.state == "pending" })
            || !taskStates.isDisjoint(with: ["waiting_input", "user_review", "failed"]) {
            return .attention
        }
        if !taskStates.isDisjoint(with: ["running", "reviewing"])
            || commands.contains(where: { ["queued", "dispatching", "running"].contains($0.state) }) {
            return .active
        }
        return .idle
    }
}

struct NativeAppIcon: View {
    var size: CGFloat = 34

    var body: some View {
        Image(nsImage: WindowBrandAssets.icon)
            .resizable()
            .interpolation(.high)
            .scaledToFit()
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

extension View {
    func nativeCard(cornerRadius: CGFloat = 16) -> some View {
        background(NativeTheme.surface)
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .stroke(NativeTheme.border, lineWidth: 1)
            }
    }
}

struct NativeAgentAvatar: View {
    let avatar: String
    var size: CGFloat = 42

    var body: some View {
        ZStack {
            Circle().fill(
                LinearGradient(
                    colors: [NativeTheme.acid.opacity(0.46), NativeTheme.raised],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )
            if let image = bundledAvatar {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: size * 1.14, height: size * 1.14)
            } else {
                Text(fallbackText)
                    .font(.system(size: size * 0.42, weight: .bold, design: .rounded))
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .overlay(Circle().stroke(Color.white.opacity(0.10), lineWidth: 0.5))
        .accessibilityHidden(true)
    }

    private var bundledAvatar: NSImage? {
        guard let url = Bundle.main.url(forResource: avatar, withExtension: "png", subdirectory: "avatars") else {
            return nil
        }
        return NSImage(contentsOf: url)
    }

    private var fallbackText: String {
        guard !avatar.isEmpty else { return "●" }
        if avatar.hasPrefix("user-") { return "◉" }
        return String(avatar.prefix(2))
    }
}

@MainActor
enum NativeProviderAssets {
    private static let cache = NSCache<NSString, NSImage>()

    static func image(for provider: Provider) -> NSImage? {
        let key = provider.rawValue as NSString
        if let cached = cache.object(forKey: key) { return cached }
        guard let image = bundledImage(for: provider) ?? developmentImage(for: provider) else { return nil }
        cache.setObject(image, forKey: key)
        return image
    }

    private static func bundledImage(for provider: Provider) -> NSImage? {
        guard let url = Bundle.main.url(
            forResource: provider.rawValue,
            withExtension: "png",
            subdirectory: "providers"
        ) else { return nil }
        return NSImage(contentsOf: url)
    }

    private static func developmentImage(for provider: Provider) -> NSImage? {
        #if DEBUG
        let sourceDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let url = sourceDirectory
            .appendingPathComponent("../../../shared/branding/providers/\(provider.rawValue).png")
            .standardizedFileURL
        return NSImage(contentsOf: url)
        #else
        return nil
        #endif
    }
}

struct NativeProviderIcon: View {
    let provider: Provider
    var size: CGFloat = 18

    var body: some View {
        Group {
            if let image = NativeProviderAssets.image(for: provider) {
                Image(nsImage: image)
                    .renderingMode(.original)
                    .resizable()
                    .scaledToFit()
            } else {
                Text(provider == .codex ? "C" : "A")
                    .font(.system(size: size * 0.7, weight: .black))
            }
        }
        .foregroundStyle(NativeTheme.ink)
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
        .accessibilityHidden(true)
    }
}

struct NativeTaskAvatar: View {
    let project: Project?
    let provider: Provider
    var size: CGFloat = 42

    var body: some View {
        if let project {
            NativeAgentAvatar(avatar: project.agentProfile.avatar, size: size)
        } else {
            NativeProviderIcon(provider: provider, size: size)
        }
    }
}

struct NativeStatusPill: View {
    let state: String

    private var color: Color {
        switch state {
        case "waiting", "waiting_input", "user_review": NativeTheme.coral
        case "running", "reviewing": NativeTheme.sage
        case "failed": NativeTheme.coral
        case "completed": NativeTheme.acid
        default: NativeTheme.muted
        }
    }

    var body: some View {
        Text(TaskPresentationRules.stateLabel(state))
            .font(.system(size: 11, weight: .bold))
            .foregroundStyle(color)
            .padding(.horizontal, 9)
            .frame(height: 25)
            .background(color.opacity(0.13))
            .clipShape(Capsule())
            .overlay(Capsule().stroke(color.opacity(0.19), lineWidth: 1))
    }
}

struct NativeCoreActionButton: View {
    let state: CoreActionState
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                CoreActionGlyph(state: state)
                    .frame(width: 48, height: 48)
                VStack(alignment: .leading, spacing: 2) {
                    Text("新任务")
                        .font(.system(size: 14, weight: .bold, design: .rounded))
                    Text(subtitle)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(NativeTheme.ink.opacity(0.62))
                }
                Spacer(minLength: 0)
                Text("⌘N")
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundStyle(NativeTheme.ink.opacity(0.42))
            }
            .padding(.horizontal, 10)
            .frame(height: 62)
            .foregroundStyle(NativeTheme.ink)
            .background(NativeTheme.acid.opacity(state == .attention ? 0.19 : 0.12))
            .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 15, style: .continuous)
                    .stroke(NativeTheme.acid.opacity(0.26), lineWidth: 1)
            }
        }
        .buttonStyle(.plain)
        .keyboardShortcut("n", modifiers: .command)
        .accessibilityLabel("新任务")
        .accessibilityValue(subtitle)
    }

    private var subtitle: String {
        switch state {
        case .idle: "把目标交给 Agent"
        case .active: "Agent 正在工作"
        case .attention: "有任务需要处理"
        case .offline: "等待本地服务"
        case .composing: "正在编辑"
        }
    }
}

private struct CoreActionGlyph: View {
    let state: CoreActionState

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: state == .offline || state == .composing)) { context in
            let time = context.date.timeIntervalSinceReferenceDate
            let rotation = Angle.degrees(time * (state == .active ? 88 : 24))
            let pulse = state == .attention ? 0.82 + 0.18 * sin(time * 5.4) : 1
            ZStack {
                Circle()
                    .stroke(NativeTheme.acid.opacity(state == .offline ? 0.18 : 0.30), lineWidth: 1)
                    .scaleEffect(pulse)

                Circle()
                    .trim(from: 0.05, to: state == .active ? 0.72 : 0.42)
                    .stroke(
                        state == .attention ? NativeTheme.coral : NativeTheme.acid,
                        style: StrokeStyle(lineWidth: 2.4, lineCap: .round)
                    )
                    .rotationEffect(rotation)
                    .padding(4)

                Circle()
                    .trim(from: 0.18, to: 0.44)
                    .stroke(NativeTheme.ink.opacity(0.62), style: StrokeStyle(lineWidth: 1.3, lineCap: .round))
                    .rotationEffect(-rotation * 0.7)
                    .padding(9)

                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(state == .attention ? NativeTheme.coral : NativeTheme.acid)
                    .frame(width: 22, height: 22)
                    .rotationEffect(.degrees(state == .composing ? 45 : 0))
                    .overlay {
                        Image(systemName: state == .composing ? "pencil" : "arrow.up.right")
                            .font(.system(size: 9, weight: .black))
                            .foregroundStyle(NativeTheme.paper)
                    }
                    .shadow(color: (state == .attention ? NativeTheme.coral : NativeTheme.acid).opacity(0.42), radius: 8)
            }
        }
    }
}
