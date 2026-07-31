import SwiftUI

struct TaskDetailView: View {
    @ObservedObject var model: AppModel
    let session: AgentSession
    @State private var followUp = ""
    @State private var reviewChangesMode = false

    init(model: AppModel, session: AgentSession) {
        self.model = model
        self.session = session
        _followUp = State(initialValue: UserDefaults.standard.string(forKey: "zimlo.task-draft.\(session.id)") ?? "")
    }

    private var project: Project? { session.projectId.flatMap { id in model.snapshot.projects.first { $0.id == id } } }
    private var posts: [FeedPost] { model.snapshot.posts.filter { $0.sessionId == session.id }.sorted { $0.createdAt > $1.createdAt } }
    private var commands: [TaskCommand] {
        (model.localFollowUps(session: session) + model.snapshot.commands.filter { $0.sessionId == session.id })
            .sorted { $0.createdAt > $1.createdAt }
    }
    private var task: TaskRecord? { model.snapshot.tasks.filter { $0.sessionId == session.id }.max { $0.updatedAt < $1.updatedAt } }
    private var sessionEvents: [UnifiedEvent] { model.events[session.id] ?? [] }
    private var currentState: String { task?.state ?? session.status }
    private var pendingActions: [PendingAction] { model.snapshot.actions.filter { $0.sessionId == session.id && $0.state == "pending" } }
    private var activeQueue: [TaskCommand] { commands.filter { ["queued", "dispatching", "running"].contains($0.state) } }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                LazyVStack(spacing: 0) {
                    compactHeader
                    if !pendingActions.isEmpty { attentionSection }
                    if let review = latestReview { reviewSection(review) }
                    timeline
                }
            }
            .scrollIndicators(.hidden)
            .background(ZColor.paper)

            VStack(spacing: 5) {
                VoiceInput(text: $followUp, placeholder: canContinue ? "说出或输入下一步…" : "当前任务关联待确认")
                if !activeQueue.isEmpty {
                    Text("当前有 \(activeQueue.count) 条指令正在执行或排队")
                        .font(ZFont.caption2).foregroundStyle(ZColor.muted)
                }
                Button(reviewChangesMode ? "发送修改要求" : willQueue ? "加入队列" : "发送") {
                    let value = followUp.trimmingCharacters(in: .whitespacesAndNewlines)
                    if reviewChangesMode, let review = latestReview {
                        model.respondReview(review, decision: "request_changes", note: value)
                        reviewChangesMode = false
                        followUp = ""
                        UserDefaults.standard.removeObject(forKey: "zimlo.task-draft.\(session.id)")
                    } else if model.followUp(sessionId: session.id, text: value) {
                        // 发送即清空：持久化成功后同一交互周期清空输入与草稿；
                        // 本地 pending 由时间线中的 local: 条目立即展示，失败则保留原文。
                        followUp = ""
                        UserDefaults.standard.removeObject(forKey: "zimlo.task-draft.\(session.id)")
                    }
                }
                .buttonStyle(ActionButtonStyle(primary: true))
                .disabled(!canContinue || followUp.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || duplicateActive)
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(ZColor.paper)
            .overlay(alignment: .top) { Rectangle().fill(ZColor.line).frame(height: 1) }
        }
        .clipShape(RoundedRectangle(cornerRadius: ZRadius.sheet, style: .continuous))
        .padding(.horizontal, 8).padding(.bottom, 5)
        .onChange(of: followUp) { _, value in
            UserDefaults.standard.set(value, forKey: "zimlo.task-draft.\(session.id)")
        }
        .task(id: timelineItems.first?.id) {
            guard let latest = timelineItems.first?.id,
                  model.snapshot.taskTimelineCursors[session.id] != latest else { return }
            try? await Task.sleep(for: .seconds(1))
            model.markTimelineSeen(sessionId: session.id, itemId: latest)
        }
    }

    private var latestReview: TaskReview? {
        model.snapshot.reviews.filter { $0.sessionId == session.id }.max { $0.version < $1.version }
    }

    @ViewBuilder
    private func reviewSection(_ review: TaskReview) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("RESULT REVIEW · V\(review.version)").font(ZFont.caption2).foregroundStyle(ZColor.muted)
                    Text(review.bundle.conclusion).font(ZFont.title3)
                }
                Spacer()
                Text(review.state == "unreviewed" ? "等待确认" : review.state == "accepted" ? "已接受" : review.state == "changes_requested" ? "已要求修改" : "已有新版本")
                    .font(ZFont.caption2).foregroundStyle(ZColor.muted)
            }
            if let impact = review.bundle.impact {
                Text(impact).font(ZFont.footnote).foregroundStyle(ZColor.ink.opacity(0.76))
            }
            HStack {
                Text(review.bundle.evidenceSource == "app_server" ? "应用已验证" : review.bundle.evidenceSource == "hook" ? "Hook 已验证" : "Agent 报告")
                Spacer()
                if !review.bundle.changedFiles.isEmpty { Text("\(review.bundle.changedFiles.count) 个文件") }
            }
            .font(ZFont.caption2).foregroundStyle(ZColor.muted)
            ForEach(review.bundle.tests, id: \.detail) { test in
                Text("\(test.label) · \(test.detail)")
                    .font(ZFont.footnote).foregroundStyle(ZColor.ink.opacity(0.72))
            }
            if review.state == "unreviewed" {
                HStack {
                    Button("接受结果") { model.respondReview(review, decision: "accept") }
                        .buttonStyle(ActionButtonStyle(primary: true))
                    Button("要求修改") {
                        reviewChangesMode = true
                        model.showNotice("请在底部输入具体修改要求")
                    }
                    .buttonStyle(ActionButtonStyle(primary: false))
                }
            }
        }
        .padding(16)
        .background(ZColor.acid.opacity(0.09))
        .overlay(RoundedRectangle(cornerRadius: ZRadius.inner).stroke(ZColor.line))
        .clipShape(RoundedRectangle(cornerRadius: ZRadius.inner))
        .padding(.horizontal, 14).padding(.top, 12)
    }

    private var compactHeader: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack(spacing: 10) {
                AgentAvatar(value: project?.agentProfile.avatar ?? "Z", size: 42)
                VStack(alignment: .leading, spacing: 2) {
                    Text(project?.agentProfile.displayName ?? session.provider.label).font(ZFont.headline)
                    HStack(spacing: 6) {
                        ProviderBadge(provider: session.provider, surface: session.surface)
                        Text(session.projectName ?? session.cwd?.split(separator: "/").last.map(String.init) ?? "未归属")
                            .font(ZFont.footnote).foregroundStyle(ZColor.muted).lineLimit(1)
                    }
                }
            }
            VStack(alignment: .leading, spacing: 5) {
                Text("TASK INPUT").font(ZFont.caption2).foregroundStyle(ZColor.muted)
                Text(taskInput).font(ZFont.title3).lineLimit(3)
            }
            if let latest = posts.first {
                HStack(alignment: .top, spacing: 18) {
                    headerFact("最新结论", latest.headline)
                    headerFact("现在需要你", nextAction)
                }
            } else {
                headerFact("现在需要你", nextAction)
            }
        }
        .foregroundStyle(ZColor.ink)
        .padding(.horizontal, 18).padding(.vertical, 16)
        .overlay(alignment: .bottom) { Rectangle().fill(ZColor.line).frame(height: 1) }
    }

    private func headerFact(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(ZFont.caption2).foregroundStyle(ZColor.sage)
            Text(value).font(ZFont.footnote.weight(.bold)).lineLimit(3)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private var attentionSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("待处理").font(ZFont.caption).foregroundStyle(ZColor.coral)
            ForEach(pendingActions) { action in
                VStack(alignment: .leading, spacing: 8) {
                    Text(action.title).font(ZFont.callout.weight(.black))
                    Text(action.detail).font(ZFont.footnote).foregroundStyle(ZColor.muted).lineLimit(3)
                    PendingActionControls(model: model, action: action, limit: 2)
                }
            }
        }
        .padding(15).frame(maxWidth: .infinity, alignment: .leading)
        .background(ZColor.coral.opacity(0.08))
        .foregroundStyle(ZColor.ink)
    }

    private var timeline: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("动态").font(ZFont.title3)
                Spacer()
                Text("关键轮次在第一层").font(ZFont.caption2).foregroundStyle(ZColor.muted)
            }
            .padding(.horizontal, 18).padding(.vertical, 14)

            ForEach(timelineItems) { item in
                TimelineRow(
                    model: model, item: item, project: project,
                    userAvatar: model.snapshot.userProfile.avatarId, events: sessionEvents
                )
            }
            if timelineItems.isEmpty {
                VStack(spacing: 8) {
                    Text("还没有需要阅读的更新").font(ZFont.callout.weight(.black))
                    Text("工具调用和普通执行日志不会出现在这里。").font(ZFont.footnote).foregroundStyle(ZColor.muted)
                }
                .frame(maxWidth: .infinity).padding(.vertical, 40)
            }
        }
        .foregroundStyle(ZColor.ink)
    }

    private var taskInput: String {
        let first = sessionEvents.filter { $0.kind == "user_instruction" }.min { $0.sequence < $1.sequence }
        return first?.payload.stringValue ?? session.title
    }

    private var nextAction: String {
        if let action = pendingActions.first { return action.title }
        if !activeQueue.isEmpty { return "等待当前步骤结束" }
        switch currentState {
        case "waiting_input": return "回复 Agent，让任务继续"
        case "user_review": return "审阅最新结果；需要调整时追加指令"
        case "running", "reviewing": return "Agent 正在执行，无需操作"
        case "failed": return "查看失败原因并决定是否重试"
        default: return "可以继续布置任务"
        }
    }

    private var statusLabel: String {
        ["running": "进行中", "waiting": "等待中", "idle": "可继续", "completed": "已完成",
         "failed": "失败", "ended": "已结束", "waiting_input": "等你回复",
         "reviewing": "检查中", "user_review": "待你审阅"][currentState] ?? "状态未知"
    }

    private var statusColor: Color { ["failed", "waiting_input", "user_review"].contains(currentState) ? ZColor.coral : ZColor.sage }
    private var canContinue: Bool { session.cwd != nil && !session.correlationUncertain }
    private var willQueue: Bool { session.activePid != nil || ["running", "waiting", "reviewing"].contains(currentState) }
    private var duplicateActive: Bool { activeQueue.contains { $0.text.trimmingCharacters(in: .whitespacesAndNewlines) == followUp.trimmingCharacters(in: .whitespacesAndNewlines) } }
    private var timelineCount: Int { timelineItems.count }

    private var timelineItems: [TaskTimelineItem] {
        var values = posts.map { TaskTimelineItem.post($0) }
        values += commands.map { TaskTimelineItem.command($0) }
        let commandTexts = Set(commands.map { $0.text.trimmingCharacters(in: .whitespacesAndNewlines) })
        values += sessionEvents
            .filter { $0.kind == "user_instruction" }
            .filter { !commandTexts.contains(($0.payload.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)) }
            .map { TaskTimelineItem.event($0) }
        return values.sorted { $0.at > $1.at }
    }
}

enum TaskTimelineItem: Identifiable {
    case post(FeedPost)
    case command(TaskCommand)
    case event(UnifiedEvent)

    var id: String {
        switch self {
        case .post(let value): "post:\(value.id)"
        case .command(let value): "command:\(value.id)"
        case .event(let value): "event:\(value.id)"
        }
    }
    var at: String {
        switch self {
        case .post(let value): value.createdAt
        case .command(let value): value.createdAt
        case .event(let value): value.occurredAt
        }
    }
}

private struct TimelineRow: View {
    @ObservedObject var model: AppModel
    let item: TaskTimelineItem
    let project: Project?
    let userAvatar: String
    let events: [UnifiedEvent]

    var body: some View {
        HStack(alignment: .top, spacing: 11) {
            avatar
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 5) {
                    Text(author).font(ZFont.subheadline.weight(.black))
                    Text(label).font(ZFont.footnote).foregroundStyle(ZColor.muted)
                    TimelineView(.periodic(from: .now, by: 30)) { _ in
                        Text("· \(relative(item.at))").font(ZFont.caption2).foregroundStyle(ZColor.muted)
                    }
                }
                if !title.isEmpty { Text(title).font(ZFont.headline) }
                Text(summary).font(ZFont.subheadline).lineSpacing(3).lineLimit(6)
                if case .command(let command) = item, command.state == "failed" {
                    Button("重试") { model.retry(commandId: command.id) }
                        .font(ZFont.caption)
                        .foregroundStyle(ZColor.coral)
                }
                if !details.isEmpty {
                    DisclosureGroup("查看 \(details.count) 项执行细节") {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(details, id: \.self) { Text("• \($0)").font(ZFont.footnote).foregroundStyle(ZColor.muted) }
                        }.padding(.top, 7)
                    }
                    .font(ZFont.caption).tint(ZColor.sage)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16).padding(.vertical, 14)
        .overlay(alignment: .bottom) { Rectangle().fill(ZColor.line).frame(height: 1) }
    }

    @ViewBuilder private var avatar: some View {
        switch item {
        case .command, .event:
            UserAvatar(id: userAvatar, size: 36)
        default:
            AgentAvatar(value: project?.agentProfile.avatar ?? "Z", size: 36)
        }
    }
    private var author: String {
        if case .command = item { return "你" }
        if case .event = item { return "你" }
        return project?.agentProfile.displayName ?? "Agent"
    }
    private var label: String {
        switch item {
        case .post(let post): return ["result": "结果", "failure": "失败 / 风险", "attention": "需要关注", "decision": "新的判断"][post.kind] ?? "阶段成果"
        case .command(let command): return command.kind == "create" ? "创建任务" : "追加指令"
        case .event: return "本轮指令"
        }
    }
    private var title: String {
        if case .post(let post) = item { return post.headline }
        return ""
    }
    private var summary: String {
        switch item {
        case .post(let post): return post.takeaway
        case .command(let command): return command.text
        case .event(let event): return event.payload.stringValue ?? label
        }
    }
    private var details: [String] {
        switch item {
        case .post(let post):
            return post.highlights + [post.proof].compactMap { $0 } + [post.actionPrompt].compactMap { $0 }
        case .command(let command):
            let instruction = events.first {
                $0.kind == "user_instruction"
                    && ($0.payload.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    == command.text.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            guard let instruction else { return [] }
            return detailsForInstruction(instruction)
        case .event(let instruction):
            return detailsForInstruction(instruction)
        }
    }

    private func detailsForInstruction(_ instruction: UnifiedEvent) -> [String] {
        let sorted = events.sorted { $0.sequence < $1.sequence }
        let related: [UnifiedEvent]
        if let turnId = instruction.turnId {
            related = sorted.filter { $0.id != instruction.id && $0.turnId == turnId }
        } else if let index = sorted.firstIndex(where: { $0.id == instruction.id }) {
            related = Array(sorted.dropFirst(index + 1).prefix { $0.kind != "user_instruction" })
        } else {
            related = []
        }
        let labels = [
            "plan_updated": "计划", "files_changed": "文件变更", "tests_passed": "验证",
            "tests_failed": "验证失败", "blocked": "受阻", "completed": "完成", "failed": "失败",
        ]
        return related.prefix(8).map { event in
            let value = event.payload.stringValue ?? "状态已更新"
            let concise = value.count > 500 ? "\(value.prefix(500))…" : value
            return "\(labels[event.kind] ?? "执行")：\(concise)"
        }
    }
}

struct NewTaskView: View {
    @ObservedObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @AppStorage("zimlo.lastWorkspace") private var lastWorkspace = ""
    @AppStorage("zimlo.lastProvider") private var lastProvider = Provider.codex.rawValue
    @AppStorage("zimlo.newTaskDraft") private var text = ""
    @State private var search = ""
    @State private var choosingAgent = false
    @State private var submitting = false

    private var selectedWorkspace: TrustedWorkspace? {
        model.snapshot.workspaces.first { $0.id == lastWorkspace }
    }

    private var selectedProject: Project? {
        guard let workspace = selectedWorkspace else { return nil }
        return model.snapshot.projects.first { $0.paths.contains(workspace.path) }
    }

    private var selectedProvider: Provider {
        Provider(rawValue: lastProvider) ?? .codex
    }

    private var visibleWorkspaces: [TrustedWorkspace] {
        let values = search.isEmpty ? model.snapshot.workspaces : model.snapshot.workspaces.filter { workspace in
            let project = model.snapshot.projects.first { project in project.paths.contains(workspace.path) }
            return workspace.label.localizedCaseInsensitiveContains(search)
                || workspace.path.localizedCaseInsensitiveContains(search)
                || project?.agentProfile.displayName.localizedCaseInsensitiveContains(search) == true
        }
        return values.sorted { $0.lastUsedAt > $1.lastUsedAt }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        VStack(alignment: .leading, spacing: 9) {
                            HStack {
                                Text("你想完成什么？").font(ZFont.headline)
                                Spacer()
                                Text(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "草稿自动保存" : "草稿已保存")
                                    .font(ZFont.caption2).foregroundStyle(ZColor.muted)
                            }
                            VoiceInput(
                                text: $text,
                                placeholder: "例如：检查首页白屏原因，修复后跑完测试并告诉我结果…",
                                minHeight: 150
                            )
                            Text("直接描述想要的结果；Agent 会自己拆解步骤，需要决定时再来找你。")
                                .font(ZFont.caption2).foregroundStyle(ZColor.muted)
                        }

                        VStack(alignment: .leading, spacing: 9) {
                            HStack {
                                Text("交给谁").font(ZFont.headline)
                                Spacer()
                                Text("已沿用最近选择").font(ZFont.caption2).foregroundStyle(ZColor.muted)
                            }
                            Button {
                                withAnimation(.easeOut(duration: 0.18)) { choosingAgent.toggle() }
                            } label: {
                                HStack(spacing: 11) {
                                    AgentAvatar(value: selectedProject?.agentProfile.avatar ?? "●", size: 46)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(selectedProject?.agentProfile.displayName ?? selectedWorkspace?.label ?? "选择 Agent")
                                            .font(ZFont.headline).lineLimit(1)
                                        Text(selectedProject.map { "\($0.name) · 已记住项目上下文" } ?? selectedWorkspace?.label ?? "暂无可信项目")
                                            .font(ZFont.caption2).foregroundStyle(ZColor.muted).lineLimit(1)
                                    }
                                    Spacer()
                                    ProviderBadge(provider: selectedProvider, iconOnly: true)
                                    Text(choosingAgent ? "收起" : "更换").font(ZFont.caption2).foregroundStyle(ZColor.sage)
                                }
                                .padding(12).foregroundStyle(ZColor.ink)
                                .background(ZColor.acid.opacity(0.08))
                                .overlay(RoundedRectangle(cornerRadius: ZRadius.inner, style: .continuous).stroke(ZColor.sage.opacity(0.28)))
                                .clipShape(RoundedRectangle(cornerRadius: ZRadius.inner, style: .continuous))
                            }
                            .buttonStyle(.plain)
                            .disabled(model.snapshot.workspaces.isEmpty)

                            if choosingAgent {
                                VStack(spacing: 11) {
                                    TextField("搜索 Agent 或项目", text: $search)
                                        .textFieldStyle(.roundedBorder).foregroundStyle(ZColor.ink)
                                    LazyVStack(spacing: 0) {
                                        ForEach(visibleWorkspaces) { workspace in
                                            let project = model.snapshot.projects.first { $0.paths.contains(workspace.path) }
                                            Button {
                                                choose(workspace, project: project)
                                            } label: {
                                                HStack(spacing: 10) {
                                                    AgentAvatar(value: project?.agentProfile.avatar ?? "●", size: 36)
                                                    VStack(alignment: .leading, spacing: 2) {
                                                        Text(project?.agentProfile.displayName ?? workspace.label)
                                                            .font(ZFont.caption).lineLimit(1)
                                                        Text(project?.name ?? workspace.label)
                                                            .font(ZFont.caption2).foregroundStyle(ZColor.muted).lineLimit(1)
                                                    }
                                                    Spacer()
                                                    HStack(spacing: 3) {
                                                        ForEach(workspace.providers) { ProviderBadge(provider: $0, iconOnly: true) }
                                                    }
                                                    if workspace.id == lastWorkspace {
                                                        Image(systemName: "checkmark").font(ZFont.caption).foregroundStyle(ZColor.sage)
                                                    }
                                                }
                                                .padding(.horizontal, 10).padding(.vertical, 8)
                                                .foregroundStyle(ZColor.ink)
                                                .background(workspace.id == lastWorkspace ? ZColor.acid.opacity(0.1) : Color.white.opacity(0.65))
                                            }
                                            .buttonStyle(.plain)
                                            Divider()
                                        }
                                    }
                                    .frame(maxHeight: 220)
                                    .clipShape(RoundedRectangle(cornerRadius: ZRadius.control, style: .continuous))

                                    HStack {
                                        Text("执行方式").font(ZFont.caption2).foregroundStyle(ZColor.muted)
                                        Spacer()
                                        ForEach(Provider.allCases) { provider in
                                            Button {
                                                lastProvider = provider.rawValue
                                            } label: {
                                                HStack(spacing: 5) {
                                                    ProviderIcon(provider: provider)
                                                    Text(provider.label).font(ZFont.caption2)
                                                }
                                                .padding(.horizontal, 10).padding(.vertical, 7)
                                                .foregroundStyle(ZColor.ink)
                                                .background(lastProvider == provider.rawValue ? Color.white : Color.clear)
                                                .overlay(Capsule().stroke(lastProvider == provider.rawValue ? ZColor.muted : ZColor.line))
                                                .clipShape(Capsule())
                                            }
                                            .buttonStyle(.plain)
                                            .disabled(selectedWorkspace?.providers.contains(provider) == false)
                                            .opacity(selectedWorkspace?.providers.contains(provider) == false ? 0.32 : 1)
                                        }
                                    }
                                }
                                .padding(12)
                                .background(ZColor.line.opacity(0.35))
                                .clipShape(RoundedRectangle(cornerRadius: ZRadius.inner, style: .continuous))
                            }
                        }

                        if model.snapshot.workspaces.isEmpty {
                            Text("先在 Mac 的 Codex 或 Claude Code 中打开一次项目，Zimlo 才能安全地把任务交给它。")
                                .font(ZFont.footnote).foregroundStyle(ZColor.coral)
                        }
                    }
                    .padding(20)
                }

                HStack(spacing: 14) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(lastWorkspace.isEmpty ? "还没有可用 Agent" : "交给 \(selectedProject?.agentProfile.displayName ?? selectedWorkspace?.label ?? "Agent")")
                            .font(ZFont.caption).lineLimit(1)
                        Text("提交后可离开，任务会继续运行")
                            .font(ZFont.caption2).foregroundStyle(ZColor.muted)
                    }
                    Spacer()
                    Button {
                        guard !submitting else { return }
                        submitting = true
                        model.createTask(
                            provider: selectedProvider,
                            workspaceId: lastWorkspace,
                            text: text.trimmingCharacters(in: .whitespacesAndNewlines)
                        )
                        text = ""
                        dismiss()
                    } label: {
                        HStack { Text("开始任务"); Image(systemName: "arrow.right") }
                    }
                    .buttonStyle(ActionButtonStyle(primary: true))
                    .frame(width: 142)
                    .disabled(submitting || lastWorkspace.isEmpty || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                .padding(.horizontal, 20).padding(.vertical, 13)
                .background(ZColor.paper)
                .overlay(alignment: .top) { Divider() }
            }
            .foregroundStyle(ZColor.ink).background(ZColor.paper)
            .navigationTitle("新任务")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.foregroundStyle(ZColor.ink) }
            }
            .onAppear {
                if let projectId = model.newTaskProjectId,
                   let project = model.snapshot.projects.first(where: { $0.id == projectId }),
                   let workspace = model.snapshot.workspaces.first(where: { project.paths.contains($0.path) }) {
                    lastWorkspace = workspace.id
                    lastProvider = project.agentProfile.defaultProvider?.rawValue ?? lastProvider
                }
                if !model.snapshot.workspaces.contains(where: { $0.id == lastWorkspace }) {
                    lastWorkspace = visibleWorkspaces.first?.id ?? ""
                }
                if let workspace = selectedWorkspace,
                   !workspace.providers.contains(selectedProvider),
                   let first = workspace.providers.first {
                    lastProvider = first.rawValue
                }
            }
        }
    }

    private func choose(_ workspace: TrustedWorkspace, project: Project?) {
        lastWorkspace = workspace.id
        if let preferred = project?.agentProfile.defaultProvider, workspace.providers.contains(preferred) {
            lastProvider = preferred.rawValue
        } else if !workspace.providers.contains(selectedProvider), let first = workspace.providers.first {
            lastProvider = first.rawValue
        }
        search = ""
        withAnimation(.easeOut(duration: 0.18)) { choosingAgent = false }
    }
}
