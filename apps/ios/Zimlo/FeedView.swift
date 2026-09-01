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
    private var palette: ZimloCardPalette { ZimloCardPalette(theme: post.presentation.theme) }
    private var isFullBleed: Bool { post.presentation.mediaPlacement == "full_bleed" && mediaContent != nil }
    private var cardPadding: CGFloat {
        switch post.presentation.density {
        case "airy": 28
        case "compact": 18
        default: 22
        }
    }
    private var titleFont: Font {
        let design: Font.Design = switch post.presentation.typography {
        case "serif": .serif
        case "mono": .monospaced
        case "rounded": .rounded
        default: .default
        }
        return .system(.largeTitle, design: design).weight(post.presentation.system == "swiss" ? .black : .bold)
    }

    var body: some View {
        ZStack {
            if isFullBleed, let mediaContent {
                FeedMaterialCard(model: model, content: mediaContent, fullBleed: true)
                    .ignoresSafeArea()
                LinearGradient(colors: [.black.opacity(0.54), .clear, .black.opacity(0.88)], startPoint: .top, endPoint: .bottom)
            }
            VStack(alignment: .leading, spacing: 0) {
                header
                Spacer(minLength: isFullBleed ? 110 : 18)
                mainContent
                Spacer(minLength: 16)
                footer
            }
            .padding(cardPadding)
        }
        .foregroundStyle(isFullBleed ? Color.white : palette.ink)
        .background(isFullBleed ? Color.black : palette.surface)
        .clipShape(RoundedRectangle(cornerRadius: post.presentation.system == "swiss" ? 8 : ZRadius.card, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: post.presentation.system == "swiss" ? 8 : ZRadius.card, style: .continuous)
                .stroke(isFullBleed ? Color.white.opacity(0.2) : palette.ink.opacity(0.22), lineWidth: post.presentation.system == "swiss" ? 2 : 1)
        }
        .shadow(color: post.presentation.system == "swiss" ? palette.accent : .clear, radius: 0, x: 6, y: 6)
    }

    private var header: some View {
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
        .font(ZFont.footnote)
        .foregroundStyle(isFullBleed ? Color.white.opacity(0.72) : palette.ink.opacity(0.62))
    }

    @ViewBuilder private var mainContent: some View {
        if post.presentation.mediaPlacement == "split", let mediaContent {
            HStack(alignment: .center, spacing: 16) {
                FeedMaterialCard(model: model, content: mediaContent)
                    .frame(maxWidth: .infinity)
                copy
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else {
            VStack(alignment: .leading, spacing: 0) {
                if !isFullBleed, let mediaContent {
                    FeedMaterialCard(model: model, content: mediaContent)
                        .frame(maxHeight: post.presentation.mediaPlacement == "inline" ? 330 : 240)
                        .padding(.bottom, 16)
                }
                copy
            }
        }
    }

    private var copy: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("\(post.kind.uppercased()) / \(post.presentation.system.uppercased())")
                .font(ZFont.caption2.monospaced().weight(.black))
                .tracking(1.2)
                .foregroundStyle(isFullBleed ? Color.white.opacity(0.78) : palette.accent)
                .padding(.bottom, 10)
            Text(post.headline)
                .font(titleFont)
                .foregroundStyle(isFullBleed ? Color.white : palette.ink)
                .lineSpacing(-1)
                .lineLimit(post.presentation.density == "compact" ? 2 : 3)
                .minimumScaleFactor(0.72)
            Text(post.takeaway)
                .font(ZFont.body)
                .foregroundStyle(isFullBleed ? Color.white.opacity(0.74) : palette.ink.opacity(0.72))
                .lineLimit(post.presentation.density == "compact" ? 3 : 5)
                .lineSpacing(4)
                .padding(.top, 14)
            CardBlocksView(blocks: post.blocks, palette: palette, fullBleed: isFullBleed, layout: post.presentation.layout)
                .padding(.top, post.blocks.isEmpty ? 0 : 16)
            if !post.highlights.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(post.highlights.prefix(2), id: \.self) { fact in
                        HStack(alignment: .top, spacing: 9) {
                            Image(systemName: "checkmark").fontWeight(.black).foregroundStyle(isFullBleed ? Color.white : palette.accent)
                            Text(fact).font(ZFont.callout.weight(.semibold)).lineLimit(2)
                        }
                    }
                }
                .foregroundStyle(isFullBleed ? Color.white.opacity(0.82) : palette.ink.opacity(0.82))
                .padding(.top, 15)
            }
        }
    }

    private var footer: some View {
        HStack(alignment: .bottom, spacing: 10) {
            if let proof = post.proof, !proof.isEmpty {
                Label(proof, systemImage: "checkmark.seal.fill")
                    .font(ZFont.caption2.monospaced().weight(.bold))
                    .lineLimit(2)
            }
            Spacer()
            if historical || session == nil {
                Text(historical ? "历史内容" : "新任务上下文").font(ZFont.footnote.weight(.bold))
            } else {
                Text("查看任务 →").font(ZFont.footnote.weight(.black))
            }
        }
        .foregroundStyle(isFullBleed ? Color.white.opacity(0.76) : palette.ink.opacity(0.68))
        .padding(.top, 12)
        .overlay(alignment: .top) { Rectangle().fill(isFullBleed ? Color.white.opacity(0.22) : palette.ink.opacity(0.18)).frame(height: 1) }
    }
}

private struct CardBlocksView: View {
    let blocks: [CardBlock]
    let palette: ZimloCardPalette
    let fullBleed: Bool
    let layout: String

    private var foreground: Color { fullBleed ? .white : palette.ink }

    var body: some View {
        if layout == "metric_grid" {
            LazyVGrid(columns: [.init(.flexible()), .init(.flexible())], spacing: 0) { blockViews }
        } else {
            VStack(alignment: .leading, spacing: 0) { blockViews }
        }
    }

    @ViewBuilder private var blockViews: some View {
        ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
            switch block.type {
            case "metric":
                VStack(alignment: .leading, spacing: 8) {
                    Text(block.label ?? "METRIC").font(ZFont.caption2.monospaced().weight(.black))
                    Spacer(minLength: 10)
                    Text((block.value ?? "—") + (block.unit.map { " \($0)" } ?? ""))
                        .font(.system(.title, design: .rounded).weight(.black)).minimumScaleFactor(0.65)
                    if let caption = block.caption { Text(caption).font(ZFont.caption2).opacity(0.62) }
                }
                .padding(12).frame(maxWidth: .infinity, minHeight: 104, alignment: .leading)
                .background(index == 0 && !fullBleed ? palette.accent : foreground.opacity(0.06))
                .overlay(Rectangle().stroke(foreground.opacity(0.5), lineWidth: 1))
            case "quote":
                VStack(alignment: .leading, spacing: 9) {
                    Text("“\(block.text ?? "")”").font(ZFont.title2).fontWeight(.bold)
                    if let attribution = block.attribution { Text("— \(attribution)").font(ZFont.caption) }
                }
                .padding(.leading, 14).overlay(alignment: .leading) { Rectangle().fill(fullBleed ? .white : palette.accent).frame(width: 5) }
            case "comparison":
                HStack(spacing: 0) {
                    comparison(block.left, highlighted: false)
                    comparison(block.right, highlighted: true)
                }
            case "step":
                HStack(alignment: .top, spacing: 11) {
                    Text(String(format: "%02d", index + 1)).font(ZFont.caption2.monospaced().weight(.black)).foregroundStyle(fullBleed ? .white : palette.accent)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(block.label ?? "").font(ZFont.callout.weight(.bold))
                        if let detail = block.detail { Text(detail).font(ZFont.caption2).opacity(0.64) }
                    }
                }
                .padding(.vertical, 9).frame(maxWidth: .infinity, alignment: .leading)
                .background(block.phase == "current" ? palette.accent : .clear)
                .overlay(alignment: .top) { Rectangle().fill(foreground.opacity(0.2)).frame(height: 1) }
            default:
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(block.label ?? "FACT").font(ZFont.caption2.monospaced().weight(.black)).foregroundStyle(fullBleed ? .white : palette.accent)
                        if let detail = block.detail { Text(detail).font(ZFont.caption2).opacity(0.64) }
                    }
                    Spacer()
                    if let value = block.value { Text(value).font(ZFont.headline) }
                }
                .padding(.vertical, 9).overlay(alignment: .top) { Rectangle().fill(foreground.opacity(0.2)).frame(height: 1) }
            }
        }
    }

    private func comparison(_ item: CardComparisonItem?, highlighted: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(item?.label ?? "—").font(ZFont.caption2.monospaced().weight(.black))
            Text(item?.value ?? "—").font(ZFont.headline).fixedSize(horizontal: false, vertical: true)
            if let detail = item?.detail { Text(detail).font(ZFont.caption2).opacity(0.64) }
        }
        .padding(11).frame(maxWidth: .infinity, alignment: .leading)
        .background(highlighted && !fullBleed ? palette.accent : foreground.opacity(0.04))
        .overlay(Rectangle().stroke(foreground.opacity(0.5), lineWidth: 1))
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
