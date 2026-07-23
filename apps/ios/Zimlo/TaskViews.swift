import SwiftUI

struct TaskDetailView: View {
    @ObservedObject var model: AppModel
    let session: AgentSession
    @State private var followUp = ""

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
            HStack(spacing: 12) {
                Button { model.selectedSession = nil } label: {
                    Image(systemName: "arrow.left").font(.system(size: 17, weight: .bold))
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(project?.agentProfile.displayName ?? session.title)
                        .font(.system(size: 15, weight: .black)).lineLimit(1)
                    Text("\(timelineCount) 条关键动态")
                        .font(.system(size: 10, weight: .medium)).foregroundStyle(ZColor.muted)
                }
                Spacer()
                Text(statusLabel).font(.system(size: 10, weight: .black))
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .background(statusColor.opacity(0.16)).foregroundStyle(statusColor).clipShape(Capsule())
            }
            .foregroundStyle(ZColor.ink)
            .padding(.horizontal, 16).frame(height: 52)
            .background(ZColor.paper)

            ScrollView {
                LazyVStack(spacing: 0) {
                    compactHeader
                    if !pendingActions.isEmpty { attentionSection }
                    timeline
                }
            }
            .scrollIndicators(.hidden)
            .background(ZColor.paper)

            VStack(spacing: 5) {
                VoiceInput(text: $followUp, placeholder: canContinue ? "说出或输入下一步…" : "当前任务关联待确认")
                if !activeQueue.isEmpty {
                    Text("当前有 \(activeQueue.count) 条指令正在执行或排队")
                        .font(.system(size: 10, weight: .semibold)).foregroundStyle(ZColor.muted)
                }
                Button(willQueue ? "加入队列" : "发送") {
                    let value = followUp.trimmingCharacters(in: .whitespacesAndNewlines)
                    model.followUp(sessionId: session.id, text: value)
                }
                .buttonStyle(ActionButtonStyle(primary: true))
                .disabled(!canContinue || followUp.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || duplicateActive)
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(ZColor.paper)
            .overlay(alignment: .top) { Rectangle().fill(ZColor.line).frame(height: 1) }
        }
        .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
        .padding(.horizontal, 8).padding(.bottom, 5)
        .onChange(of: followUp) { _, value in
            UserDefaults.standard.set(value, forKey: "zimlo.task-draft.\(session.id)")
        }
        .onChange(of: commands.map { "\($0.state):\($0.text)" }) { _, _ in
            if commands.contains(where: { $0.state == "completed" && $0.text.trimmingCharacters(in: .whitespacesAndNewlines) == followUp.trimmingCharacters(in: .whitespacesAndNewlines) }) {
                followUp = ""
            }
        }
        .task(id: timelineItems.first?.id) {
            guard let latest = timelineItems.first?.id,
                  model.snapshot.taskTimelineCursors[session.id] != latest else { return }
            try? await Task.sleep(for: .seconds(1))
            model.markTimelineSeen(sessionId: session.id, itemId: latest)
        }
    }

    private var compactHeader: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack(spacing: 10) {
                Text(project?.agentProfile.avatar ?? "Z").font(.system(size: 25))
                    .frame(width: 42, height: 42).background(ZColor.acid.opacity(0.4)).clipShape(Circle())
                VStack(alignment: .leading, spacing: 2) {
                    Text(project?.agentProfile.displayName ?? session.provider.label).font(.system(size: 16, weight: .black))
                    Text("\(session.runtimeLabel) · \(session.projectName ?? session.cwd?.split(separator: "/").last.map(String.init) ?? "未归属")")
                        .font(.system(size: 11, weight: .medium)).foregroundStyle(ZColor.muted).lineLimit(1)
                }
            }
            VStack(alignment: .leading, spacing: 5) {
                Text("TASK INPUT").font(.system(size: 9, weight: .black)).foregroundStyle(ZColor.muted)
                Text(taskInput).font(.system(size: 18, weight: .bold)).lineLimit(3)
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
            Text(label).font(.system(size: 9, weight: .black)).foregroundStyle(ZColor.sage)
            Text(value).font(.system(size: 12, weight: .bold)).lineLimit(3)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private var attentionSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("待处理").font(.system(size: 11, weight: .black)).foregroundStyle(ZColor.coral)
            ForEach(pendingActions) { action in
                VStack(alignment: .leading, spacing: 8) {
                    Text(action.title).font(.system(size: 15, weight: .black))
                    Text(action.detail).font(.system(size: 12, weight: .medium)).foregroundStyle(ZColor.muted).lineLimit(3)
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
                Text("动态").font(.system(size: 20, weight: .black))
                Spacer()
                Text("关键轮次在第一层").font(.system(size: 10, weight: .semibold)).foregroundStyle(ZColor.muted)
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
                    Text("还没有需要阅读的更新").font(.system(size: 15, weight: .black))
                    Text("工具调用和普通执行日志不会出现在这里。").font(.system(size: 12)).foregroundStyle(ZColor.muted)
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
                    Text(author).font(.system(size: 13, weight: .black))
                    Text(label).font(.system(size: 11, weight: .semibold)).foregroundStyle(ZColor.muted)
                    Text("· \(relative(item.at))").font(.system(size: 10)).foregroundStyle(ZColor.muted)
                }
                if !title.isEmpty { Text(title).font(.system(size: 16, weight: .black)) }
                Text(summary).font(.system(size: 14, weight: .medium)).lineSpacing(3).lineLimit(6)
                if case .command(let command) = item, command.state == "failed" {
                    Button("重试") { model.retry(commandId: command.id) }
                        .font(.system(size: 11, weight: .black))
                        .foregroundStyle(ZColor.coral)
                }
                if !details.isEmpty {
                    DisclosureGroup("查看 \(details.count) 项执行细节") {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(details, id: \.self) { Text("• \($0)").font(.system(size: 12, weight: .medium)).foregroundStyle(ZColor.muted) }
                        }.padding(.top, 7)
                    }
                    .font(.system(size: 11, weight: .bold)).tint(ZColor.sage)
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
            Text(project?.agentProfile.avatar ?? "Z").font(.system(size: 18))
                .frame(width: 36, height: 36).background(ZColor.acid.opacity(0.35)).clipShape(Circle())
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

    private var visibleWorkspaces: [TrustedWorkspace] {
        let values = search.isEmpty ? model.snapshot.workspaces : model.snapshot.workspaces.filter {
            $0.label.localizedCaseInsensitiveContains(search) || $0.path.localizedCaseInsensitiveContains(search)
        }
        return values.sorted { $0.lastUsedAt > $1.lastUsedAt }
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 18) {
                Picker("Runtime", selection: $lastProvider) {
                    ForEach(Provider.allCases) { provider in Text(provider.label).tag(provider.rawValue) }
                }
                .pickerStyle(.segmented)
                TextField("搜索 Agent、项目或路径", text: $search)
                    .textFieldStyle(.roundedBorder).foregroundStyle(ZColor.ink)
                Picker("Project Agent", selection: $lastWorkspace) {
                    ForEach(visibleWorkspaces) { workspace in
                        Text("\(workspace.label) · \(workspace.path)").tag(workspace.id)
                    }
                }
                .pickerStyle(.menu).tint(ZColor.ink)
                VoiceInput(text: $text, placeholder: "说出或输入你想完成什么…")
                Spacer()
                if model.snapshot.workspaces.isEmpty {
                    Text("先在 Mac 的 Codex 或 Claude Code 中打开一次项目，Zimlo 才会把它加入可信列表。")
                        .font(.system(size: 12, weight: .medium)).foregroundStyle(ZColor.coral)
                }
                Button("开始任务") {
                    guard let provider = Provider(rawValue: lastProvider) else { return }
                    model.createTask(provider: provider, workspaceId: lastWorkspace, text: text.trimmingCharacters(in: .whitespacesAndNewlines))
                    text = ""
                    dismiss()
                }
                .buttonStyle(ActionButtonStyle(primary: true))
                .disabled(lastWorkspace.isEmpty || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(20).foregroundStyle(ZColor.ink).background(ZColor.paper)
            .navigationTitle("布置新任务")
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
            }
        }
    }
}
