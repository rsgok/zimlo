import SwiftUI

private enum NativeTaskFilter: String, CaseIterable, Identifiable {
    case all
    case attention
    case active
    case ready
    case archived

    var id: String { rawValue }
    var label: String {
        switch self {
        case .all: "全部"
        case .attention: "待我处理"
        case .active: "进行中"
        case .ready: "可继续"
        case .archived: "已归档"
        }
    }
}

struct NativeTasksView: View {
    @ObservedObject var store: NativeAppStore
    @State private var filter: NativeTaskFilter = .all
    @State private var query = ""

    private var sessions: [AgentSession] {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let recentBoundary = Date().addingTimeInterval(-7 * 24 * 60 * 60)
        return collapsedSessions
            .filter { session in
                let state = store.snapshot.task(for: session.id)?.state ?? session.status
                let preference = store.snapshot.preference(for: session.id)
                let archived = preference?.archivedAt != nil
                switch filter {
                case .all where archived: return false
                case .attention where archived || !["waiting", "waiting_input", "user_review", "failed"].contains(state): return false
                case .active where archived || !["running", "reviewing"].contains(state): return false
                case .ready where archived || !["idle", "completed", "ended"].contains(state): return false
                case .archived where !archived: return false
                default: break
                }
                if filter != .archived,
                   preference?.pinnedAt == nil,
                   priority(state) >= 2,
                   session.lastActivityAt.zimloDate < recentBoundary {
                    return false
                }
                guard !normalized.isEmpty else { return true }
                let project = store.snapshot.project(for: session)
                return [session.title, session.cwd, project?.name, project?.agentProfile.displayName]
                    .compactMap { $0?.lowercased() }
                    .contains { $0.contains(normalized) }
            }
            .sorted { left, right in
                let leftPinned = store.snapshot.preference(for: left.id)?.pinnedAt != nil
                let rightPinned = store.snapshot.preference(for: right.id)?.pinnedAt != nil
                if leftPinned != rightPinned { return leftPinned }
                let leftState = store.snapshot.task(for: left.id)?.state ?? left.status
                let rightState = store.snapshot.task(for: right.id)?.state ?? right.status
                let leftPriority = priority(leftState)
                let rightPriority = priority(rightState)
                if leftPriority != rightPriority { return leftPriority < rightPriority }
                return left.lastActivityAt > right.lastActivityAt
            }
    }

    private var collapsedSessions: [AgentSession] {
        var direct: [AgentSession] = []
        var processGroups: [String: AgentSession] = [:]
        for session in store.snapshot.sessions {
            guard session.providerSessionId.hasPrefix("process:") else {
                direct.append(session)
                continue
            }
            let key = "\(session.provider.rawValue):\(session.cwd ?? "unknown")"
            if let current = processGroups[key], current.lastActivityAt >= session.lastActivityAt { continue }
            processGroups[key] = session
        }
        return direct + processGroups.values
    }

    var body: some View {
        VStack(spacing: 0) {
            taskFilter
            if sessions.isEmpty {
                ContentUnavailableView(
                    query.isEmpty ? "这里还没有任务" : "没有匹配的任务",
                    systemImage: query.isEmpty ? "checkmark.circle" : "magnifyingglass",
                    description: Text(query.isEmpty ? "新任务和正在工作的 Agent 会出现在这里。" : "换一个关键词或筛选条件试试。")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .foregroundStyle(NativeTheme.muted)
            } else {
                List(sessions) { session in
                    NativeTaskRow(store: store, session: session)
                        .listRowInsets(.init(top: 5, leading: 24, bottom: 5, trailing: 24))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
            }
        }
        .background(NativeTheme.paper)
        .navigationTitle("Tasks")
        .searchable(text: $query, placement: .toolbar, prompt: "搜索任务或项目")
    }

    private var taskFilter: some View {
        HStack(spacing: 10) {
            Picker("任务状态", selection: $filter) {
                ForEach(NativeTaskFilter.allCases) { item in
                    Text(item.label).tag(item)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize(horizontal: true, vertical: false)
            Spacer()
            Text("\(sessions.count) 个任务")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(NativeTheme.muted)
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 15)
        .background(NativeTheme.paper)
        .overlay(alignment: .bottom) { Divider().overlay(NativeTheme.border) }
    }

    private func priority(_ state: String) -> Int {
        if ["waiting", "waiting_input", "user_review", "failed"].contains(state) { return 0 }
        if ["running", "reviewing"].contains(state) { return 1 }
        return 2
    }
}

private struct NativeTaskRow: View {
    @ObservedObject var store: NativeAppStore
    let session: AgentSession

    private var task: TaskRecord? { store.snapshot.task(for: session.id) }
    private var project: Project? { store.snapshot.project(for: session) }
    private var state: String { task?.state ?? session.status }
    private var pinned: Bool { store.snapshot.preference(for: session.id)?.pinnedAt != nil }

    var body: some View {
        NavigationLink(value: NativeRoute.task(session.id)) {
            HStack(spacing: 14) {
                NativeTaskAvatar(project: project, provider: session.provider, size: 38)
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 6) {
                        Text(TaskPresentationRules.shortTitle(session.title, limit: 54))
                            .font(.system(size: 14, weight: .bold))
                            .foregroundStyle(NativeTheme.ink)
                            .lineLimit(1)
                        if pinned {
                            Image(systemName: "pin.fill")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundStyle(NativeTheme.acid)
                        }
                    }
                    Text(metadata)
                        .font(.system(size: 10.5, weight: .medium))
                        .foregroundStyle(NativeTheme.muted)
                        .lineLimit(1)
                }
                Spacer(minLength: 14)
                NativeStatusPill(state: state)
            }
            .padding(.horizontal, 15)
            .frame(minHeight: 70)
            .nativeCard(cornerRadius: 14)
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button(pinned ? "取消置顶" : "置顶任务", systemImage: pinned ? "pin.slash" : "pin") {
                Task { await store.setPinned(sessionID: session.id, pinned: !pinned) }
            }
            Button("归档任务", systemImage: "archivebox") {
                Task { await store.setArchived(sessionID: session.id, archived: true) }
            }
        }
    }

    private var metadata: String {
        let location = project?.name ?? session.projectName ?? session.cwd ?? "未归属项目"
        let date = session.lastActivityAt.zimloDate.formatted(.relative(presentation: .named))
        return "\(location) · \(session.runtimeLabel) · \(date)"
    }
}

struct NativeTaskProfileView: View {
    @ObservedObject var store: NativeAppStore
    let session: AgentSession
    let onReply: () -> Void

    @State private var highRiskDecision: Decision?
    @State private var confirmation = ""
    @State private var inputAnswer = ""

    private var project: Project? { store.snapshot.project(for: session) }
    private var task: TaskRecord? { store.snapshot.task(for: session.id) }
    private var state: String { task?.state ?? session.status }
    private var events: [UnifiedEvent] { store.eventsBySession[session.id] ?? [] }
    private var posts: [FeedPost] {
        store.snapshot.posts.filter { $0.sessionId == session.id }.sorted { $0.createdAt > $1.createdAt }
    }
    private var commands: [TaskCommand] {
        store.snapshot.commands.filter { $0.sessionId == session.id }.sorted { $0.createdAt > $1.createdAt }
    }
    private var action: PendingAction? { store.snapshot.pendingAction(for: session.id) }
    private var preference: TaskPreference? { store.snapshot.preference(for: session.id) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                taskHeader
                if let action { NativeActionCard(store: store, action: action, inputAnswer: $inputAnswer, highRiskDecision: $highRiskDecision) }
                timeline
            }
            .padding(.horizontal, 30)
            .padding(.vertical, 26)
            .frame(maxWidth: 920, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .background(NativeTheme.paper)
        .navigationTitle(TaskPresentationRules.shortTitle(session.title, limit: 22))
        .toolbar {
            ToolbarItemGroup {
                Button(action: onReply) { Label("回复", systemImage: "bubble.left.fill") }
                Menu {
                    Button(preference?.pinnedAt == nil ? "置顶任务" : "取消置顶", systemImage: "pin") {
                        Task { await store.setPinned(sessionID: session.id, pinned: preference?.pinnedAt == nil) }
                    }
                    Button(preference?.archivedAt == nil ? "归档任务" : "恢复任务", systemImage: "archivebox") {
                        Task { await store.setArchived(sessionID: session.id, archived: preference?.archivedAt == nil) }
                    }
                } label: { Image(systemName: "ellipsis.circle") }
            }
        }
        .task(id: session.id) { await store.loadEvents(sessionID: session.id) }
        .sheet(item: $highRiskDecision) { decision in
            NativeHighRiskConfirmation(
                action: action,
                decision: decision,
                confirmation: $confirmation,
                onConfirm: {
                    guard let action else { return }
                    Task { await store.decide(action: action, decision: decision) }
                    highRiskDecision = nil
                    confirmation = ""
                }
            )
        }
    }

    private var taskHeader: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 12) {
                NativeTaskAvatar(project: project, provider: session.provider, size: 48)
                VStack(alignment: .leading, spacing: 3) {
                    Text(project?.agentProfile.displayName ?? session.provider.label)
                        .font(.system(size: 16, weight: .bold))
                    Text("\(session.runtimeLabel) · \(project?.name ?? session.projectName ?? "未归属项目")")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(NativeTheme.muted)
                }
                Spacer()
                NativeStatusPill(state: state)
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("TASK INPUT")
                    .font(.system(size: 10, weight: .black, design: .monospaced))
                    .tracking(1.2)
                    .foregroundStyle(NativeTheme.muted)
                Text(originalInput)
                    .font(.system(size: 25, weight: .bold, design: .rounded))
                    .foregroundStyle(NativeTheme.ink)
                    .lineSpacing(4)
                    .textSelection(.enabled)
            }

            HStack(alignment: .top, spacing: 12) {
                NativeTaskFact(
                    label: "最新结论",
                    value: posts.first?.takeaway ?? fallbackConclusion,
                    color: NativeTheme.sage,
                    important: true
                )
                if let nextAction {
                    NativeTaskFact(label: "下一步", value: nextAction, color: NativeTheme.coral, important: true)
                }
            }
        }
        .padding(22)
        .nativeCard(cornerRadius: 19)
    }

    private var originalInput: String {
        let instructionEvent = events
            .filter { $0.kind == "user_instruction" }
            .sorted { $0.sequence < $1.sequence }
            .first
        let instruction = instructionEvent.flatMap(TimelineEventPresentation.text(for:))
        return TaskPresentationRules.clean(instruction?.isEmpty == false ? instruction! : session.title)
    }

    private var fallbackConclusion: String {
        if let reason = task?.reason, !reason.isEmpty { return reason }
        return state == "running" ? "Agent 正在执行，尚未形成新的结论。" : "暂时没有可提炼的新结论。"
    }

    private var nextAction: String? {
        if let action { return action.title }
        switch state {
        case "waiting", "waiting_input": return "回复 Agent，让任务继续"
        case "user_review": return posts.first == nil ? "查看任务结果" : "审阅最新结论"
        case "failed": return "查看失败原因并决定是否重试"
        default: return nil
        }
    }

    private var timeline: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack {
                Text("动态")
                    .font(.system(size: 21, weight: .bold, design: .rounded))
                Spacer()
                Text("结论优先，执行细节按需展开")
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(NativeTheme.muted)
            }
            ForEach(timelineItems) { item in
                NativeTimelineRow(store: store, item: item)
            }
            if timelineItems.isEmpty {
                Text("还没有可展示的任务动态。")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(NativeTheme.muted)
                    .padding(18)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .nativeCard()
            }
        }
    }

    private var timelineItems: [NativeTimelineItem] {
        let postItems = posts.map(NativeTimelineItem.post)
        let commandItems = commands.map(NativeTimelineItem.command)
        let eventItems = TimelineEventPresentation.deduplicated(events
            .filter { ["user_instruction", "plan_updated", "tests_passed", "tests_failed", "blocked", "completed", "failed"].contains($0.kind) })
            .map(NativeTimelineItem.event)
        return (postItems + commandItems + eventItems).sorted { $0.date > $1.date }
    }
}

private struct NativeTaskFact: View {
    let label: String
    let value: String
    let color: Color
    let important: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(label)
                .font(.system(size: 10.5, weight: .bold))
                .foregroundStyle(color)
            Text(value)
                .font(.system(size: important ? 13 : 12, weight: important ? .semibold : .regular))
                .foregroundStyle(NativeTheme.ink.opacity(0.88))
                .lineLimit(4)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(color.opacity(0.075))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(color.opacity(0.14), lineWidth: 1))
    }
}

private struct NativeActionCard: View {
    @ObservedObject var store: NativeAppStore
    let action: PendingAction
    @Binding var inputAnswer: String
    @Binding var highRiskDecision: Decision?

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack {
                Label(action.kind == "input" ? "Agent 在等你的回复" : "需要你决定", systemImage: action.kind == "input" ? "text.bubble.fill" : "checkmark.shield.fill")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(NativeTheme.coral)
                Spacer()
                Text(action.expiresAt.zimloDate, style: .relative)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(NativeTheme.muted)
            }
            Text(action.title).font(.system(size: 17, weight: .bold, design: .rounded))
            if !action.detail.isEmpty {
                Text(action.detail)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(NativeTheme.ink.opacity(0.72))
                    .lineLimit(5)
            }
            if action.kind == "input" {
                HStack(spacing: 8) {
                    TextField("直接回复 Agent…", text: $inputAnswer)
                        .textFieldStyle(.plain)
                        .padding(.horizontal, 12)
                        .frame(height: 36)
                        .background(NativeTheme.raised)
                        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                    Button("提交") {
                        let decision = Decision(id: "submit-input", label: "提交回复", scope: "input", value: .null, risk: "low")
                        let answer = inputAnswer.trimmingCharacters(in: .whitespacesAndNewlines)
                        Task { await store.decide(action: action, decision: decision, input: ["answer": answer]) }
                        inputAnswer = ""
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(NativeTheme.acid)
                    .disabled(inputAnswer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            } else {
                HStack(spacing: 8) {
                    ForEach(action.availableDecisions) { decision in
                        Button(decision.label) { handle(decision) }
                        .buttonStyle(.borderedProminent)
                        .tint(decision.scope == "deny" ? NativeTheme.control : NativeTheme.acid)
                    }
                }
            }
        }
        .padding(18)
        .background(NativeTheme.coral.opacity(0.07))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(NativeTheme.coral.opacity(0.19), lineWidth: 1))
    }

    private func handle(_ decision: Decision) {
        if decision.confirmationPhrase != nil {
            highRiskDecision = decision
        } else {
            Task { await store.decide(action: action, decision: decision) }
        }
    }
}

private struct NativeHighRiskConfirmation: View {
    let action: PendingAction?
    let decision: Decision
    @Binding var confirmation: String
    let onConfirm: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("高风险操作", systemImage: "exclamationmark.triangle.fill")
                .font(.system(size: 16, weight: .bold))
                .foregroundStyle(NativeTheme.coral)
            Text(action?.title ?? decision.label).font(.system(size: 20, weight: .bold, design: .rounded))
            Text(action?.detail ?? "确认后将立即执行。")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(NativeTheme.muted)
            Text("输入「\(decision.confirmationPhrase ?? "")」确认")
                .font(.system(size: 12, weight: .semibold))
            TextField("确认短语", text: $confirmation)
                .textFieldStyle(.roundedBorder)
            HStack {
                Button("填入短语") { confirmation = decision.confirmationPhrase ?? "" }
                Spacer()
                Button("确认执行", action: onConfirm)
                    .buttonStyle(.borderedProminent)
                    .tint(NativeTheme.coral)
                    .disabled(confirmation != decision.confirmationPhrase)
            }
        }
        .padding(24)
        .frame(width: 460)
        .background(NativeTheme.paper)
    }
}

private enum NativeTimelineItem: Identifiable {
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
    var date: Date {
        switch self {
        case .post(let value): value.createdAt.zimloDate
        case .command(let value): value.createdAt.zimloDate
        case .event(let value): value.occurredAt.zimloDate
        }
    }
}

private struct NativeTimelineRow: View {
    @ObservedObject var store: NativeAppStore
    let item: NativeTimelineItem

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: symbol)
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(color)
                Text(label).font(.system(size: 11, weight: .bold)).foregroundStyle(color)
                Spacer()
                Text(item.date.formatted(date: .abbreviated, time: .shortened))
                    .font(.system(size: 9.5, weight: .medium))
                    .foregroundStyle(NativeTheme.muted)
            }
            Text(title).font(.system(size: 14, weight: .bold)).foregroundStyle(NativeTheme.ink).lineLimit(3)
            if !detail.isEmpty {
                Text(detail)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(NativeTheme.ink.opacity(0.70))
                    .lineLimit(6)
                    .textSelection(.enabled)
            }
            if case .post(let post) = item, let content = post.content {
                NativeTimelineMaterials(store: store, content: content)
            }
        }
        .padding(16)
        .nativeCard(cornerRadius: 14)
    }

    private var label: String {
        switch item {
        case .post(let post): ["result": "结论", "failure": "风险", "attention": "需要关注", "decision": "新的判断"][post.kind] ?? "阶段成果"
        case .command(let command): command.kind == "create" ? "任务指令" : "你的回复"
        case .event(let event): ["user_instruction": "你布置了任务", "plan_updated": "计划已更新", "tests_passed": "验证通过", "tests_failed": "验证失败", "blocked": "任务受阻", "completed": "本轮完成", "failed": "执行失败"][event.kind] ?? "任务事件"
        }
    }
    private var title: String {
        switch item {
        case .post(let post): TaskPresentationRules.preview(post.headline)
        case .command(let command): TaskPresentationRules.preview(command.text)
        case .event(let event): TaskPresentationRules.shortTitle(TimelineEventPresentation.text(for: event) ?? label, limit: 80)
        }
    }
    private var detail: String {
        switch item {
        case .post(let post): return TaskPresentationRules.clean(post.takeaway)
        case .command(let command): return ["queued": "等待当前步骤结束", "dispatching": "正在准备", "running": "Agent 正在执行", "completed": "已完成", "failed": command.error ?? "发送失败", "canceled": "已取消"][command.state] ?? command.state
        case .event(let event):
            guard let value = TimelineEventPresentation.text(for: event), value.count > 80 else { return "" }
            return TaskPresentationRules.clean(value)
        }
    }
    private var symbol: String {
        switch item {
        case .post: "sparkles"
        case .command: "arrow.up.circle.fill"
        case .event: "circle.dotted"
        }
    }
    private var color: Color {
        if case .post(let post) = item, post.kind == "failure" { return NativeTheme.coral }
        if case .command(let command) = item, command.state == "failed" { return NativeTheme.coral }
        return NativeTheme.acid
    }
}

private struct NativeTimelineMaterials: View {
    @ObservedObject var store: NativeAppStore
    let content: FeedContent
    private var ids: [String] { content.materialIds ?? [content.materialId].compactMap { $0 } }
    var body: some View {
        HStack {
            ForEach(ids, id: \.self) { id in
                if let material = store.snapshot.materials.first(where: { $0.id == id }) {
                    Button { store.openMaterial(material) } label: {
                        Label(material.name, systemImage: "paperclip")
                            .font(.system(size: 10, weight: .semibold))
                    }
                    .buttonStyle(.bordered)
                }
            }
        }
    }
}
