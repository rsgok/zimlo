import SwiftUI

struct NativeFeedView: View {
    @ObservedObject var model: AppModel
    let resetRequest: Int
    @State private var visibleID: String?
    @State private var currentOrder: [String] = []
    @State private var showNewContent = false

    var body: some View {
        // Feed projection is intentionally built once per render. It used to be
        // recomputed for every card, position lookup and empty-state check.
        let entries = model.feedEntries
        let byID = Dictionary(uniqueKeysWithValues: entries.map { ($0.id, $0) })
        let current = currentOrder.compactMap { byID[$0] }
        let currentIDs = Set(currentOrder)
        let history = entries.filter { !currentIDs.contains($0.id) }
        return GeometryReader { geometry in
            ScrollView(.vertical) {
                LazyVStack(spacing: 0) {
                    ForEach(current) { entry in
                        FeedPage(model: model, entry: entry)
                            .frame(width: geometry.size.width, height: geometry.size.height)
                            .id(entry.id)
                    }
                    CaughtUpPage(hasHistory: !history.isEmpty)
                        .frame(width: geometry.size.width, height: geometry.size.height)
                        .id(FeedCohortRules.caughtUpID)
                    ForEach(history) { entry in
                        FeedPage(model: model, entry: entry, historical: true)
                            .frame(width: geometry.size.width, height: geometry.size.height)
                            .id(entry.id)
                    }
                }
                .scrollTargetLayout()
            }
            .scrollIndicators(.hidden)
            // Keep the TikTok-style one-card stop. View-aligned snapping feels
            // more direct than container paging while alwaysByOne guarantees that
            // one interaction can advance by at most one card.
            .feedScrollTargetBehavior()
            .scrollPosition(id: $visibleID)
            .background(ZColor.canvas)
            .onAppear { updateCohort() }
            .onChange(of: FeedCohortRules.signature(entries)) { _, _ in updateCohort() }
            .onChange(of: resetRequest) { _, _ in resetToBeginning() }
            .onChange(of: visibleID) { _, _ in
                if showNewContent { showNewContent = false }
            }
            .task(id: visibleID) {
                // scrollPosition 在布局和 sheet 转场期间可能短暂回传 nil；这不是
                // 用户离开当前卡片，不能因此丢掉“回复当前会话”的上下文。
                guard let id = visibleID else { return }
                guard let entry = byID[id] else {
                    if id == FeedCohortRules.caughtUpID {
                        model.activeFeedSessionId = nil
                        model.activeFeedProjectId = nil
                    }
                    return
                }
                model.activeFeedSessionId = entry.sessionId
                model.activeFeedProjectId = projectID(for: entry)
                guard
                      case .post(let post) = entry.content, entry.unread else { return }
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled, visibleID == id else { return }
                model.markSeen(post.id)
            }
            .overlay(alignment: .top) {
                // ScrollView 会让相邻页面绘制到系统状态栏下面。分页位置本身是
                // 正确的，但上一张卡底部的“历史内容”会穿透透明状态栏，看起来
                // 像没有吸附到位。用当前容器的真实安全区遮住这段非交互区域。
                ZStack(alignment: .top) {
                    ZColor.canvas
                        .frame(height: geometry.safeAreaInsets.top)
                        .frame(maxWidth: .infinity)
                        .offset(y: -geometry.safeAreaInsets.top)
                    if showNewContent {
                        Text("有新内容")
                            .font(ZFont.caption.weight(.bold))
                            .foregroundStyle(ZColor.ink)
                            .padding(.horizontal, 14).frame(minHeight: 36)
                            .background(.ultraThinMaterial)
                            .clipShape(Capsule())
                            .padding(.top, 12)
                            .transition(.move(edge: .top).combined(with: .opacity))
                    }
                }
                .frame(maxWidth: .infinity, alignment: .top)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
        }
    }

    private func updateCohort() {
        let entries = model.feedEntries
        let previous = currentOrder
        let next = FeedCohortRules.reconcile(previous: previous, entries: entries)
        if !previous.isEmpty && next.contains(where: { !Set(previous).contains($0) }) {
            showNewContent = true
        }
        let arrival = FeedCohortRules.arrivalTarget(
            visibleID: visibleID,
            previous: previous,
            next: next,
            entries: entries
        )
        let initial = visibleID == nil ? next.first : nil
        let target = arrival ?? initial
        // A read receipt changes the Feed signature one second after settling on a
        // card. Updating an unchanged cohort inside an animation transaction made
        // the next drag compete with a redundant layout animation.
        if next != previous { currentOrder = next }
        if let target {
            withAnimation(.snappy(duration: 0.28)) { visibleID = target }
        }
        if let target, let entry = entries.first(where: { $0.id == target }) {
            model.activeFeedSessionId = entry.sessionId
            model.activeFeedProjectId = projectID(for: entry)
        } else if next.isEmpty {
            model.activeFeedSessionId = nil
            model.activeFeedProjectId = nil
        }
    }

    private func resetToBeginning() {
        showNewContent = false
        let target = FeedCohortRules.beginningTarget(currentOrder: currentOrder)
        guard visibleID != target else { return }
        withAnimation(.snappy(duration: 0.3)) { visibleID = target }
    }

    private func projectID(for entry: FeedEntry) -> String? {
        let direct: String?
        switch entry.content {
        case .post(let post): direct = post.projectId
        case .action: direct = nil
        case .command: direct = nil
        }
        if let direct { return direct }
        guard let sessionID = entry.sessionId,
              let session = model.snapshot.sessions.first(where: { $0.id == sessionID }) else { return nil }
        if let projectID = session.projectId { return projectID }
        guard let cwd = session.cwd else { return nil }
        return model.snapshot.projects.first(where: { project in project.paths.contains(where: { cwd == $0 || cwd.hasPrefix($0 + "/") }) })?.id
    }
}

private extension View {
    @ViewBuilder
    func feedScrollTargetBehavior() -> some View {
        if #available(iOS 18.0, *) {
            scrollTargetBehavior(.viewAligned(limitBehavior: .alwaysByOne))
        } else {
            scrollTargetBehavior(.paging)
        }
    }
}

private struct FeedPage: View {
    // NativeFeedView is the single observation boundary. Nested full-screen cards
    // receive the reference only for actions, avoiding duplicate invalidations of
    // every visible page for one AppModel publication.
    let model: AppModel
    let entry: FeedEntry
    var historical = false
    @State private var offset: CGFloat = 0

    var body: some View {
        ZStack {
            HStack {
                Label("移出 Feed", systemImage: "arrow.right").foregroundStyle(ZColor.coralText)
                Spacer()
                Label("查看任务", systemImage: "arrow.left").foregroundStyle(ZColor.acid)
            }
            .font(ZFont.subheadline.weight(.black))
            .padding(.horizontal, 28)

            Group {
                switch entry.content {
                case .post(let post):
                    PostCard(model: model, post: post, historical: historical)
                case .action(let action):
                    ActionCard(model: model, action: action, historical: historical)
                case .command(let command):
                    CommandCard(model: model, command: command, historical: historical)
                }
            }
            .environment(\.colorScheme, .dark)
            // 历史卡仅降低彩度；整卡透明会连文字与控件一起压低对比度。
            .saturation(historical ? 0.5 : 1)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .offset(x: offset)
            .simultaneousGesture(
                // Give the ScrollView's vertical pan recognizer a clear head start.
                // Horizontal card actions remain available, but a normal vertical
                // flick no longer has to negotiate with a full-card drag at touch-down.
                DragGesture(minimumDistance: 28)
                    .onChanged { value in
                        guard abs(value.translation.width) > abs(value.translation.height) * 1.35 else { return }
                        offset = min(120, max(-120, value.translation.width))
                    }
                    .onEnded { value in
                        let horizontal = abs(value.translation.width) > abs(value.translation.height) * 1.35
                        if horizontal, value.translation.width < -82, let sessionId = entry.sessionId {
                            model.openTask(sessionId: sessionId)
                        } else if horizontal, value.translation.width > 82 {
                            model.dismiss(entry.id)
                        }
                        withAnimation(.spring(response: 0.28, dampingFraction: 0.8)) { offset = 0 }
                    }
            )
        }
        .accessibilityActions {
            if let sessionID = entry.sessionId {
                Button("查看任务") { model.openTask(sessionId: sessionID) }
            }
            Button("移出 Feed") { model.dismiss(entry.id) }
        }
    }
}

private struct PostCard: View {
    let model: AppModel
    let post: FeedPost
    let historical: Bool

    private var session: AgentSession? { post.sessionId.flatMap { id in model.snapshot.sessions.first { $0.id == id } } }
    private var project: Project? {
        if let id = post.projectId ?? session?.projectId,
           let project = model.snapshot.projects.first(where: { $0.id == id }) { return project }
        guard let cwd = session?.cwd else { return nil }
        return model.snapshot.projects.first { project in project.paths.contains(where: { cwd == $0 || cwd.hasPrefix($0 + "/") }) }
    }
    private var mediaContent: FeedContent? {
        guard let content = post.content, content.type != "text" else { return nil }
        return content
    }
    private var immersiveMedia: FeedContent? {
        guard let mediaContent, ["image_album", "video"].contains(mediaContent.type) else { return nil }
        return mediaContent
    }
    private var isImmersiveMedia: Bool { immersiveMedia != nil }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                if let project {
                    Button { model.openAgent(projectId: project.id) } label: {
                        AgentAvatar(value: project.agentProfile.avatar, size: 22)
                        Text(project.agentProfile.displayName).fontWeight(.semibold)
                    }
                } else {
                    Text(post.agentId).fontWeight(.semibold)
                }
                Spacer()
                TimelineView(.periodic(from: .now, by: 30)) { _ in Text(relative(post.createdAt)) }
            }
            .font(ZFont.footnote).foregroundStyle(isImmersiveMedia ? Color.white.opacity(0.7) : ZColor.muted).padding(.top, 22)

            Spacer(minLength: mediaContent == nil ? 28 : isImmersiveMedia ? 120 : 12)

            if let mediaContent, !isImmersiveMedia {
                FeedMaterialCard(model: model, content: mediaContent)
            }

            Text(post.headline)
                .font(mediaContent == nil ? ZFont.hero : isImmersiveMedia ? ZFont.title : ZFont.title)
                .foregroundStyle(isImmersiveMedia ? Color.white.opacity(0.9) : ZColor.ink)
                .lineSpacing(0)
                .lineLimit(mediaContent == nil ? 3 : isImmersiveMedia ? 2 : 1).minimumScaleFactor(0.82)
                .padding(.top, mediaContent == nil ? 12 : isImmersiveMedia ? 0 : 10)
            Text(post.takeaway)
                .font(ZFont.body)
                .foregroundStyle(isImmersiveMedia ? Color.white.opacity(0.62) : ZColor.ink.opacity(0.7))
                .lineLimit(mediaContent == nil ? 4 : isImmersiveMedia ? 3 : 2).lineSpacing(mediaContent == nil ? 4 : 2)
                .padding(.top, mediaContent == nil ? 18 : 6)
            if mediaContent == nil, !post.highlights.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(post.highlights.prefix(2), id: \.self) { fact in
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: "checkmark").fontWeight(.black).foregroundStyle(ZColor.sageText)
                            Text(fact).font(ZFont.callout.weight(.semibold)).lineLimit(2)
                        }
                    }
                }.padding(.top, 18)
            }

            Spacer(minLength: mediaContent == nil ? 22 : isImmersiveMedia ? 10 : 8)

            if historical || session == nil {
                HStack(spacing: 8) {
                    Text(historical ? "历史内容" : "新任务上下文")
                    Spacer()
                }
                .font(ZFont.footnote)
                .foregroundStyle(ZColor.ink.opacity(0.72))
                .padding(.vertical, 16)
            }
        }
        .padding(.horizontal, 20)
        .foregroundStyle(isImmersiveMedia ? Color.white : ZColor.ink)
        .background(
            ZStack(alignment: .top) {
                if let immersiveMedia {
                    FeedMaterialCard(model: model, content: immersiveMedia, fullBleed: true)
                    LinearGradient(
                        colors: [.clear, .black.opacity(0.12), .black.opacity(0.9)],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                } else {
                    ZColor.paper
                }
            }
        )
        .clipShape(RoundedRectangle(cornerRadius: ZRadius.card, style: .continuous))
    }
}

private struct ActionCard: View {
    let model: AppModel
    let action: PendingAction
    let historical: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                Text("需要你处理").font(ZFont.caption)
            }
            .foregroundStyle(ZColor.muted)
            Spacer()
            Text(action.title).font(ZFont.hero).lineSpacing(0).lineLimit(3).minimumScaleFactor(0.8)
            Text(action.detail).font(ZFont.body).foregroundStyle(ZColor.ink.opacity(0.68)).lineLimit(5)
            Spacer()
            PendingActionControls(model: model, action: action, limit: 3)
        }
        .padding(24).foregroundStyle(ZColor.ink)
        .background(ZColor.paper)
        .overlay(alignment: .top) { Rectangle().fill(ZColor.coral).frame(height: 9) }
        .clipShape(RoundedRectangle(cornerRadius: ZRadius.card, style: .continuous))
    }
}

private struct CommandCard: View {
    let model: AppModel
    let command: TaskCommand
    let historical: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                Text(command.state == "failed" ? "启动失败" : "启动中").font(ZFont.caption)
            }.foregroundStyle(ZColor.muted)
            Spacer()
            Text(command.text).font(ZFont.title).lineSpacing(0).lineLimit(4).minimumScaleFactor(0.8)
            Text(command.state == "failed" ? (command.error ?? "任务没有成功发送") : "已保存任务，正在等待 Mac 上的执行引擎接收。")
                .font(ZFont.callout).foregroundStyle(ZColor.ink.opacity(0.68))
            Spacer()
            if command.state == "failed", !command.id.hasPrefix("local:") {
                Button("原地重试") { model.retry(commandId: command.id) }
                    .buttonStyle(ActionButtonStyle(primary: true))
            }
        }
        .padding(24).foregroundStyle(ZColor.ink)
        .background(ZColor.paper)
        .overlay(alignment: .top) { Rectangle().fill(command.state == "failed" ? ZColor.coral : ZColor.sage).frame(height: 9) }
        .clipShape(RoundedRectangle(cornerRadius: ZRadius.card, style: .continuous))
    }
}

private struct CaughtUpPage: View {
    let hasHistory: Bool
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                GeometryReader { geometry in
                    ScrollView(.vertical) {
                        caughtUpContent
                            .padding(.horizontal, 28)
                            .padding(.vertical, 32)
                            .frame(maxWidth: .infinity, minHeight: geometry.size.height, alignment: .center)
                    }
                    .scrollIndicators(.visible)
                }
            } else {
                VStack(spacing: 0) {
                    Spacer()
                    caughtUpContent
                    Spacer()
                }
                .padding(28)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .foregroundStyle(ZColor.ink)
        .background(ZColor.paper)
        .environment(\.colorScheme, .dark)
    }

    private var caughtUpContent: some View {
        VStack(spacing: 0) {
            VStack(spacing: 13) {
                Text("✓")
                    .font(ZFont.title.weight(.black))
                    .frame(
                        width: dynamicTypeSize.isAccessibilitySize ? 72 : 56,
                        height: dynamicTypeSize.isAccessibilitySize ? 72 : 56
                    )
                    .foregroundStyle(ZColor.onAccent)
                    .background(ZColor.sage)
                    .clipShape(Circle())
                Text("YOU'RE ALL CAUGHT UP")
                    .font(ZFont.caption)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text("暂时没有新内容")
                .font(ZFont.title).lineSpacing(0).minimumScaleFactor(0.8)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 18)
            Text("Agent 有新的重要进展时会出现在这里。")
                .font(ZFont.footnote)
                .foregroundStyle(ZColor.muted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 270)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 9)
            if hasHistory {
                Text("继续向下浏览历史 ↓")
                    .font(ZFont.footnote)
                    .foregroundStyle(ZColor.muted)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 14)
            }
        }
    }
}

enum ActionButtonRole {
    case primary
    case neutral
    case danger
}

struct ActionButtonStyle: ButtonStyle {
    let role: ActionButtonRole
    @Environment(\.isEnabled) private var isEnabled

    init(primary: Bool) {
        role = primary ? .primary : .danger
    }

    init(role: ActionButtonRole) {
        self.role = role
    }

    func makeBody(configuration: Configuration) -> some View {
        let foreground: Color = switch role {
        case .primary: ZColor.onAccent
        case .neutral: ZColor.ink
        case .danger: ZColor.coralText
        }
        let background: Color = switch role {
        case .primary: ZColor.acid.opacity(isEnabled ? 1 : 0.32)
        case .neutral: ZColor.control
        case .danger: .clear
        }
        let stroke: Color = switch role {
        case .primary: .clear
        case .neutral: ZColor.line
        case .danger: ZColor.coral.opacity(isEnabled ? 1 : 0.35)
        }
        configuration.label
            .font(ZFont.callout.weight(.black))
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, minHeight: 44)
            .padding(.horizontal, 12).padding(.vertical, 4)
            .foregroundStyle(foreground.opacity(isEnabled ? 1 : 0.48))
            .background(background)
            .overlay(RoundedRectangle(cornerRadius: ZRadius.control).stroke(stroke))
            .clipShape(RoundedRectangle(cornerRadius: ZRadius.control, style: .continuous))
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

struct DecisionButton: View {
    @ObservedObject var model: AppModel
    let action: PendingAction
    let decision: Decision
    @State private var showingConfirmation = false

    var body: some View {
        Button(decision.label) {
            if decision.risk == "high" { showingConfirmation = true }
            else { model.decide(action: action, decision: decision) }
        }
        .buttonStyle(ActionButtonStyle(primary: decision.scope != "deny"))
        .sheet(isPresented: $showingConfirmation) {
            HighRiskApprovalSheet(
                action: action,
                decision: decision,
                onSubmit: {
                    showingConfirmation = false
                    model.decide(action: action, decision: decision, confirmation: decision.confirmationPhrase)
                },
                onCancel: { showingConfirmation = false }
            )
            .environment(\.colorScheme, .dark)
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
            .presentationBackground(ZColor.paper)
        }
    }
}

struct PendingActionControls: View {
    @ObservedObject var model: AppModel
    let action: PendingAction
    var limit: Int = 3
    @State private var answer: String

    init(model: AppModel, action: PendingAction, limit: Int = 3) {
        self.model = model
        self.action = action
        self.limit = limit
        _answer = State(initialValue: UserDefaults.standard.string(forKey: "zimlo.action-draft.\(action.actionId)") ?? "")
    }

    var body: some View {
        Group {
            if action.kind == "input" {
                HStack(spacing: 8) {
                    VoiceInput(text: $answer, placeholder: "说出或输入回答…", axis: .horizontal)
                    Button("提交") {
                        let value = answer.trimmingCharacters(in: .whitespacesAndNewlines)
                        // 发送即清空：持久化成功才清，失败保留原文。
                        if model.submitInput(action: action, answer: value) {
                            answer = ""
                            UserDefaults.standard.removeObject(forKey: "zimlo.action-draft.\(action.actionId)")
                        }
                    }
                    .font(ZFont.caption)
                    .padding(.horizontal, 12).padding(.vertical, 11)
                    .background(ZColor.acid).foregroundStyle(ZColor.onAccent)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .disabled(answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            } else {
                VStack(spacing: 8) {
                    ForEach(action.availableDecisions.prefix(limit)) { decision in
                        DecisionButton(model: model, action: action, decision: decision)
                    }
                }
            }
        }
        .task(id: answer) {
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            persistAnswerDraft()
        }
        .onDisappear { persistAnswerDraft() }
    }

    private func persistAnswerDraft() {
        let key = "zimlo.action-draft.\(action.actionId)"
        if answer.isEmpty { UserDefaults.standard.removeObject(forKey: key) }
        else { UserDefaults.standard.set(answer, forKey: key) }
    }
}

func relative(_ value: String) -> String {
    relative(value.zimloDate)
}

func relative(_ date: Date) -> String {
    let seconds = Int(Date().timeIntervalSince(date))
    if seconds < 60 { return "刚刚" }
    if seconds < 3_600 { return "\(seconds / 60) 分钟前" }
    if seconds < 86_400 { return "\(seconds / 3_600) 小时前" }
    return date.formatted(.dateTime.month(.abbreviated).day())
}
