import SwiftUI

struct NativeFeedView: View {
    @ObservedObject var model: AppModel
    @State private var visibleID: String?
    @State private var currentOrder: [String] = []

    private var current: [FeedEntry] {
        let byId = Dictionary(uniqueKeysWithValues: model.feedEntries.map { ($0.id, $0) })
        return currentOrder.compactMap { byId[$0] }
    }
    private var history: [FeedEntry] {
        let ids = Set(currentOrder)
        return model.feedEntries.filter { !ids.contains($0.id) }
    }

    var body: some View {
        GeometryReader { geometry in
            ScrollView(.vertical) {
                LazyVStack(spacing: 0) {
                    ForEach(current) { entry in
                        FeedPage(model: model, entry: entry, position: position(entry), total: current.count)
                            .frame(width: geometry.size.width, height: geometry.size.height)
                            .id(entry.id)
                    }
                    CaughtUpPage(model: model, hasHistory: !history.isEmpty)
                        .frame(width: geometry.size.width, height: geometry.size.height)
                        .id("caught-up")
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
            .background(ZColor.ink)
            .onAppear { updateCohort() }
            .onChange(of: FeedCohortRules.signature(model.feedEntries)) { _, _ in updateCohort() }
            .onChange(of: visibleID) { _, id in
                guard let id, let entry = model.feedEntries.first(where: { $0.id == id }),
                      case .post(let post) = entry.content, entry.unread else { return }
                Task {
                    try? await Task.sleep(for: .seconds(1))
                    guard visibleID == id else { return }
                    model.markSeen(post.id)
                }
            }
        }
    }

    private func position(_ entry: FeedEntry) -> Int {
        (current.firstIndex(of: entry) ?? 0) + 1
    }

    private func updateCohort() {
        currentOrder = FeedCohortRules.reconcile(previous: currentOrder, entries: model.feedEntries)
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
                Label("查看任务", systemImage: "arrow.left").foregroundStyle(ZColor.acid)
                Spacer()
                Label("移出 Feed", systemImage: "arrow.right").foregroundStyle(ZColor.coral)
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
            // 历史卡降视觉权重：降饱和与透明度，与当前卡拉开层级。
            .saturation(historical ? 0.5 : 1)
            .opacity(historical ? 0.68 : 1)
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

            Spacer(minLength: 28)

            TimelineView(.periodic(from: .now, by: 30)) { _ in
                Text(relative(post.createdAt))
                    .font(ZFont.footnote).foregroundStyle(ZColor.muted)
            }
            Text(post.headline)
                .font(ZFont.hero)
                .lineSpacing(0)
                .lineLimit(3).minimumScaleFactor(0.72)
                .padding(.top, 12)
            Text(post.takeaway)
                .font(ZFont.body)
                .foregroundStyle(ZColor.ink.opacity(0.7))
                .lineLimit(4).lineSpacing(4)
                .padding(.top, 18)
            if !post.highlights.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(post.highlights.prefix(2), id: \.self) { fact in
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: "checkmark").fontWeight(.black).foregroundStyle(ZColor.sage)
                            Text(fact).font(ZFont.callout.weight(.semibold)).lineLimit(2)
                        }
                    }
                }.padding(.top, 18)
            }

            Spacer(minLength: 22)

            VStack(alignment: .leading, spacing: 5) {
                Text("下一步").font(ZFont.caption2).foregroundStyle(ZColor.sage)
                Text(nextAction).font(ZFont.subheadline.weight(.bold)).lineLimit(2)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(ZColor.sage.opacity(0.09))
            .overlay(alignment: .leading) { Rectangle().fill(ZColor.sage).frame(width: 4) }
            .clipShape(RoundedRectangle(cornerRadius: ZRadius.control, style: .continuous))

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
                        .background(ZColor.acid).clipShape(RoundedRectangle(cornerRadius: 12))
                        .disabled(reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || session.correlationUncertain)
                    }
                    if model.hasPendingLocalReply(sessionId: session.id) {
                        Text("回复已保存在手机，等待 Mac 确认")
                            .font(ZFont.caption2).foregroundStyle(ZColor.sage)
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
        .onChange(of: reply) { _, value in
            UserDefaults.standard.set(value, forKey: "zimlo.feed-reply.\(post.id)")
        }
    }

    private var nextAction: String {
        if needsAction, let prompt = post.actionPrompt { return prompt }
        if post.kind == "failure" { return "左滑查看原因并决定下一步" }
        if post.kind == "result" { return "左滑查看完整结果" }
        if session?.status == "running" { return "Agent 继续执行，重要变化会再次出现" }
        return "等待下一条重要更新"
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
        .overlay(alignment: .top) { Rectangle().fill(command.state == "failed" ? ZColor.coral : ZColor.acid).frame(height: 9) }
        .clipShape(RoundedRectangle(cornerRadius: ZRadius.card, style: .continuous))
    }
}

private struct CaughtUpPage: View {
    @ObservedObject var model: AppModel
    let hasHistory: Bool

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            VStack(spacing: 13) {
                Text("✓")
                    .font(ZFont.title.weight(.black))
                    .frame(width: 56, height: 56)
                    .foregroundStyle(ZColor.ink)
                    .background(ZColor.acid)
                    .clipShape(Circle())
                Text("YOU'RE ALL CAUGHT UP").font(ZFont.caption)
            }
            Text(model.feedEntries.isEmpty ? "Feed 已经清空" : "当前更新已经看完")
                .font(ZFont.title).lineSpacing(0).minimumScaleFactor(0.8)
                .padding(.top, 18)
            Text("重要更新、待审批和需要回复的任务会出现在这里。")
                .font(ZFont.footnote)
                .foregroundStyle(ZColor.muted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 270)
                .padding(.top, 9)
            Button("＋ 新任务") { model.showingNewTask = true }.buttonStyle(ActionButtonStyle(primary: true))
                .frame(maxWidth: 240)
                .padding(.top, 22)
            if hasHistory {
                Text("继续向下浏览历史 ↓")
                    .font(ZFont.footnote)
                    .foregroundStyle(ZColor.muted)
                    .padding(.top, 14)
            }
            Spacer()
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .foregroundStyle(ZColor.ink)
        .background(ZColor.paper)
    }
}

struct ActionButtonStyle: ButtonStyle {
    let primary: Bool
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(ZFont.callout.weight(.black))
            .frame(maxWidth: .infinity).padding(.vertical, 13)
            .foregroundStyle(primary ? ZColor.ink : ZColor.coral)
            .background(primary ? ZColor.acid : Color.clear)
            .overlay(RoundedRectangle(cornerRadius: ZRadius.control).stroke(primary ? Color.clear : ZColor.coral))
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
                    .background(ZColor.acid).foregroundStyle(ZColor.ink)
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
        .onChange(of: answer) { _, value in
            UserDefaults.standard.set(value, forKey: "zimlo.action-draft.\(action.actionId)")
        }
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
