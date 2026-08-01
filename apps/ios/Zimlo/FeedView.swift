import SwiftUI

struct NativeFeedView: View {
    @ObservedObject var model: AppModel
    @State private var visibleID: String?
    @State private var currentOrder: [String] = []

    var body: some View {
        // Feed projection is intentionally built once per render. It used to be
        // recomputed for every card, position lookup and empty-state check.
        let entries = model.feedEntries
        let byID = Dictionary(uniqueKeysWithValues: entries.map { ($0.id, $0) })
        let current = currentOrder.compactMap { byID[$0] }
        let currentIDs = Set(currentOrder)
        let history = entries.filter { !currentIDs.contains($0.id) }
        let positions = Dictionary(uniqueKeysWithValues: current.enumerated().map { ($0.element.id, $0.offset + 1) })

        GeometryReader { geometry in
            ScrollView(.vertical) {
                LazyVStack(spacing: 0) {
                    ForEach(current) { entry in
                        FeedPage(model: model, entry: entry, position: positions[entry.id] ?? 1, total: current.count)
                            .frame(width: geometry.size.width, height: geometry.size.height)
                            .id(entry.id)
                    }
                    CaughtUpPage(model: model, feedIsEmpty: entries.isEmpty, hasHistory: !history.isEmpty)
                        .frame(width: geometry.size.width, height: geometry.size.height)
                        .id(FeedCohortRules.caughtUpID)
                    ForEach(history) { entry in
                        FeedPage(model: model, entry: entry, position: 0, total: current.count, historical: true)
                            .frame(width: geometry.size.width, height: geometry.size.height)
                            .id(entry.id)
                    }
                }
                .scrollTargetLayout()
            }
            .scrollIndicators(.hidden)
            .scrollTargetBehavior(.paging)
            .scrollPosition(id: $visibleID)
            .background(ZColor.canvas)
            .onAppear { updateCohort() }
            .onChange(of: FeedCohortRules.signature(entries)) { _, _ in updateCohort() }
            .task(id: visibleID) {
                guard let id = visibleID, let entry = byID[id],
                      case .post(let post) = entry.content, entry.unread else { return }
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled, visibleID == id else { return }
                model.markSeen(post.id)
            }
        }
    }

    private func updateCohort() {
        let entries = model.feedEntries
        let previous = currentOrder
        let next = FeedCohortRules.reconcile(previous: previous, entries: entries)
        let arrival = FeedCohortRules.arrivalTarget(
            visibleID: visibleID,
            previous: previous,
            next: next,
            entries: entries
        )
        withAnimation(.easeOut(duration: 0.22)) {
            currentOrder = next
            if let arrival { visibleID = arrival }
        }
    }
}

private struct FeedPage: View {
    @ObservedObject var model: AppModel
    let entry: FeedEntry
    let position: Int
    let total: Int
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
                    PostCard(model: model, post: post, needsAction: entry.needsAction, position: position, total: total, historical: historical)
                case .action(let action):
                    ActionCard(model: model, action: action, position: position, total: total, historical: historical)
                case .command(let command):
                    CommandCard(model: model, command: command, position: position, total: total, historical: historical)
                }
            }
            .environment(\.colorScheme, .dark)
            // 历史卡仅降低彩度；整卡透明会连文字与控件一起压低对比度。
            .saturation(historical ? 0.5 : 1)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .offset(x: offset)
            .gesture(
                DragGesture(minimumDistance: 16)
                    .onChanged { value in
                        guard abs(value.translation.width) > abs(value.translation.height) * 1.12 else { return }
                        offset = min(120, max(-120, value.translation.width))
                    }
                    .onEnded { value in
                        let horizontal = abs(value.translation.width) > abs(value.translation.height) * 1.2
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
    @ObservedObject var model: AppModel
    let post: FeedPost
    let needsAction: Bool
    let position: Int
    let total: Int
    let historical: Bool
    @State private var reply = ""

    private var session: AgentSession? { post.sessionId.flatMap { id in model.snapshot.sessions.first { $0.id == id } } }
    private var project: Project? { post.projectId.flatMap { id in model.snapshot.projects.first { $0.id == id } } }
    private var pendingActions: [PendingAction] {
        model.snapshot.actions.filter { post.pendingActionIds.contains($0.actionId) && $0.state == "pending" }
    }
    private var mediaContent: FeedContent? {
        guard let content = post.content, content.type != "text" else { return nil }
        return content
    }
    private var label: String {
        ["progress": "阶段成果", "decision": "新的判断", "attention": "需要关注", "result": "结果", "failure": "失败 / 风险"][post.kind] ?? "更新"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(historical ? "历史 · \(label)" : label).font(ZFont.caption)
                Spacer()
                if !historical {
                    Text(String(format: "%02d / %02d", position, max(total, 1)))
                        .font(ZFont.caption.monospaced())
                }
            }
            .foregroundStyle(ZColor.muted).padding(.top, 22)

            Spacer(minLength: mediaContent == nil ? 28 : 12)

            if let mediaContent {
                FeedMaterialCard(model: model, content: mediaContent)
            }

            TimelineView(.periodic(from: .now, by: 30)) { _ in
                Text(relative(post.createdAt))
                    .font(ZFont.footnote).foregroundStyle(ZColor.muted)
            }
            Text(post.headline)
                .font(mediaContent == nil ? ZFont.hero : ZFont.title)
                .lineSpacing(0)
                .lineLimit(mediaContent == nil ? 3 : 1).minimumScaleFactor(0.82)
                .padding(.top, mediaContent == nil ? 12 : 10)
            Text(post.takeaway)
                .font(ZFont.body)
                .foregroundStyle(ZColor.ink.opacity(0.7))
                .lineLimit(mediaContent == nil ? 4 : 2).lineSpacing(mediaContent == nil ? 4 : 2)
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

            Spacer(minLength: mediaContent == nil ? 22 : 8)

            if mediaContent == nil || needsAction { VStack(alignment: .leading, spacing: 5) {
                Text("下一步").font(ZFont.caption2).foregroundStyle(ZColor.sageText)
                Text(nextAction).font(ZFont.subheadline.weight(.bold)).lineLimit(2)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(ZColor.sage.opacity(0.09))
            .overlay(alignment: .leading) { Rectangle().fill(ZColor.sage).frame(width: 4) }
            .clipShape(RoundedRectangle(cornerRadius: ZRadius.control, style: .continuous))
            }

            if !pendingActions.isEmpty {
                ForEach(pendingActions) { action in
                    VStack(alignment: .leading, spacing: 7) {
                        Text(action.title).font(ZFont.caption)
                        PendingActionControls(model: model, action: action, limit: 2)
                    }.padding(.top, 10)
                }
            } else if needsAction, post.actions.contains("reply"), let session {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        VoiceInput(text: $reply, placeholder: "说出或输入回复…", axis: .horizontal)
                        Button("回复") {
                            let value = reply.trimmingCharacters(in: .whitespacesAndNewlines)
                            // 发送即清空：先持久化 outbox，成功后同一交互周期清空输入与草稿。
                            if model.followUp(sessionId: session.id, text: value) {
                                reply = ""
                                UserDefaults.standard.removeObject(forKey: "zimlo.feed-reply.\(post.id)")
                            }
                        }
                        .font(ZFont.caption)
                        .padding(.horizontal, 12).padding(.vertical, 11)
                        .foregroundStyle(ZColor.onAccent)
                        .background(ZColor.acid).clipShape(RoundedRectangle(cornerRadius: 12))
                        .disabled(reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || session.correlationUncertain)
                    }
                    if model.hasPendingLocalReply(sessionId: session.id) {
                        Text("回复已保存在手机，等待 Mac 确认")
                            .font(ZFont.caption2).foregroundStyle(ZColor.sageText)
                    }
                }.padding(.top, 10)
            }

            HStack(spacing: 8) {
                if let project {
                    Button { model.openAgent(projectId: project.id) } label: {
                        AgentAvatar(value: project.agentProfile.avatar, size: 20)
                        Text(project.agentProfile.displayName).fontWeight(.bold)
                    }
                } else if let session {
                    ProviderBadge(provider: session.provider, surface: session.surface)
                } else {
                    Text(post.agentId.uppercased()).fontWeight(.bold)
                }
                Spacer()
                if needsAction {
                    Text("需要你处理")
                        .font(ZFont.caption2)
                        .foregroundStyle(ZColor.ink)
                        .padding(.horizontal, 9).padding(.vertical, 6)
                        .background(ZColor.coral).clipShape(Capsule())
                }
            }
            .font(ZFont.footnote)
            .foregroundStyle(ZColor.ink.opacity(0.72))
            .padding(.vertical, 16)
        }
        .padding(.horizontal, 20)
        .foregroundStyle(ZColor.ink)
        .background(
            ZStack(alignment: .top) {
                ZColor.paper
                Rectangle().fill(needsAction ? ZColor.coral : Color.clear).frame(height: 9)
            }
        )
        .clipShape(RoundedRectangle(cornerRadius: ZRadius.card, style: .continuous))
        .onAppear {
            reply = UserDefaults.standard.string(forKey: "zimlo.feed-reply.\(post.id)") ?? ""
        }
        .task(id: reply) {
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            persistReplyDraft()
        }
        .onDisappear { persistReplyDraft() }
    }

    private var nextAction: String {
        if needsAction, let prompt = post.actionPrompt { return prompt }
        if post.kind == "failure" { return "左滑查看原因并决定下一步" }
        if post.kind == "result" { return "左滑查看完整结果" }
        if session?.status == "running" { return "Agent 继续执行，重要变化会再次出现" }
        return "等待下一条重要更新"
    }

    private func persistReplyDraft() {
        let key = "zimlo.feed-reply.\(post.id)"
        if reply.isEmpty { UserDefaults.standard.removeObject(forKey: key) }
        else { UserDefaults.standard.set(reply, forKey: key) }
    }
}

private struct ActionCard: View {
    @ObservedObject var model: AppModel
    let action: PendingAction
    let position: Int
    let total: Int
    let historical: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                Text("需要你处理").font(ZFont.caption)
                Spacer()
                if !historical {
                    Text(String(format: "%02d / %02d", position, max(total, 1))).font(ZFont.caption.monospaced())
                }
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
    @ObservedObject var model: AppModel
    let command: TaskCommand
    let position: Int
    let total: Int
    let historical: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                Text(command.state == "failed" ? "启动失败" : "启动中").font(ZFont.caption)
                Spacer()
                if !historical {
                    Text(String(format: "%02d / %02d", position, max(total, 1))).font(ZFont.caption.monospaced())
                }
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
            HStack(spacing: 7) {
                ProviderBadge(provider: command.provider, iconOnly: true)
                Text(command.cwd).font(ZFont.footnote).lineLimit(1)
            }
        }
        .padding(24).foregroundStyle(ZColor.ink)
        .background(ZColor.paper)
        .overlay(alignment: .top) { Rectangle().fill(command.state == "failed" ? ZColor.coral : ZColor.sage).frame(height: 9) }
        .clipShape(RoundedRectangle(cornerRadius: ZRadius.card, style: .continuous))
    }
}

private struct CaughtUpPage: View {
    @ObservedObject var model: AppModel
    let feedIsEmpty: Bool
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
            Text(feedIsEmpty ? "Feed 已经清空" : "当前更新已经看完")
                .font(ZFont.title).lineSpacing(0).minimumScaleFactor(0.8)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 18)
            Text("重要更新、待审批和需要回复的任务会出现在这里。")
                .font(ZFont.footnote)
                .foregroundStyle(ZColor.muted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 270)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 9)
            Button("＋ 新任务") { model.showingNewTask = true }.buttonStyle(ActionButtonStyle(primary: true))
                .frame(maxWidth: dynamicTypeSize.isAccessibilitySize ? 300 : 240)
                .padding(.top, 22)
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
