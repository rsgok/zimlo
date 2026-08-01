import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

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

    var body: some View {
        let projection = TaskDetailProjection(
            snapshot: model.snapshot,
            session: session,
            sessionEvents: model.events[session.id] ?? [],
            localFollowUps: model.localFollowUps(session: session)
        )
        let latestTimelineItemID = projection.timelineItems.first?.id

        return VStack(spacing: 0) {
            ScrollView {
                LazyVStack(spacing: 0) {
                    compactHeader(projection)
                    if !projection.pendingActions.isEmpty { attentionSection(projection.pendingActions) }
                    if let review = projection.latestReview { reviewSection(review) }
                    timeline(projection)
                }
            }
            .scrollIndicators(.hidden)
            .background(ZColor.paper)

            VStack(spacing: 5) {
                VoiceInput(text: $followUp, placeholder: canContinue ? "说出或输入下一步…" : "当前任务关联待确认")
                if !projection.activeQueue.isEmpty {
                    Text("当前有 \(projection.activeQueue.count) 条指令正在执行或排队")
                        .font(ZFont.caption2).foregroundStyle(ZColor.muted)
                }
                Button(reviewChangesMode ? "发送修改要求" : willQueue(projection) ? "加入队列" : "发送") {
                    let value = followUp.trimmingCharacters(in: .whitespacesAndNewlines)
                    if reviewChangesMode, let review = projection.latestReview {
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
                .disabled(!canContinue || followUp.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || duplicateActive(in: projection))
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(ZColor.paper)
            .overlay(alignment: .top) { Rectangle().fill(ZColor.line).frame(height: 1) }
        }
        .zPageSurface()
        .task(id: followUp) {
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            persistFollowUpDraft()
        }
        .onDisappear { persistFollowUpDraft() }
        .task(id: latestTimelineItemID) {
            guard let latest = latestTimelineItemID,
                  model.snapshot.taskTimelineCursors[session.id] != latest else { return }
            guard await TimelineReadDelay.wait() else { return }
            guard model.snapshot.taskTimelineCursors[session.id] != latest else { return }
            model.markTimelineSeen(sessionId: session.id, itemId: latest)
        }
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
        .background(ZColor.raised)
        .overlay(RoundedRectangle(cornerRadius: ZRadius.inner).stroke(ZColor.sage.opacity(0.34)))
        .clipShape(RoundedRectangle(cornerRadius: ZRadius.inner))
        .padding(.horizontal, 14).padding(.top, 12)
    }

    private func compactHeader(_ projection: TaskDetailProjection) -> some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack(spacing: 10) {
                AgentAvatar(value: projection.project?.agentProfile.avatar ?? "Z", size: 42)
                VStack(alignment: .leading, spacing: 2) {
                    Text(projection.project?.agentProfile.displayName ?? session.provider.label).font(ZFont.headline)
                    HStack(spacing: 6) {
                        ProviderBadge(provider: session.provider, surface: session.surface)
                        Text(session.projectName ?? session.cwd?.split(separator: "/").last.map(String.init) ?? "未归属")
                            .font(ZFont.footnote).foregroundStyle(ZColor.muted).lineLimit(1)
                    }
                }
            }
            VStack(alignment: .leading, spacing: 5) {
                Text("TASK INPUT").font(ZFont.caption2).foregroundStyle(ZColor.muted)
                Text(projection.taskInput).font(ZFont.title3).lineLimit(3)
            }
            if let latest = projection.posts.first {
                HStack(alignment: .top, spacing: 18) {
                    headerFact("最新结论", latest.headline)
                    headerFact("现在需要你", nextAction(for: projection))
                }
            } else {
                headerFact("现在需要你", nextAction(for: projection))
            }
        }
        .foregroundStyle(ZColor.ink)
        .padding(.horizontal, 18).padding(.vertical, 16)
        .overlay(alignment: .bottom) { Rectangle().fill(ZColor.line).frame(height: 1) }
    }

    private func headerFact(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(ZFont.caption2).foregroundStyle(ZColor.sageText)
            Text(value).font(ZFont.footnote.weight(.bold)).lineLimit(3)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private func attentionSection(_ actions: [PendingAction]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("待处理").font(ZFont.caption).foregroundStyle(ZColor.coralText)
            ForEach(actions) { action in
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

    private func timeline(_ projection: TaskDetailProjection) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("动态").font(ZFont.title3)
                Spacer()
                Text("关键轮次在第一层").font(ZFont.caption2).foregroundStyle(ZColor.muted)
            }
            .padding(.horizontal, 18).padding(.vertical, 14)

            ForEach(projection.timelineItems) { item in
                TimelineRow(
                    model: model,
                    item: item,
                    project: projection.project,
                    userAvatar: model.snapshot.userProfile.avatarId,
                    details: projection.detailsByItemID[item.id] ?? []
                )
            }
            if projection.timelineItems.isEmpty {
                VStack(spacing: 8) {
                    Text("还没有需要阅读的更新").font(ZFont.callout.weight(.black))
                    Text("工具调用和普通执行日志不会出现在这里。").font(ZFont.footnote).foregroundStyle(ZColor.muted)
                }
                .frame(maxWidth: .infinity).padding(.vertical, 40)
            }
        }
        .foregroundStyle(ZColor.ink)
    }

    private func nextAction(for projection: TaskDetailProjection) -> String {
        if let action = projection.pendingActions.first { return action.title }
        if !projection.activeQueue.isEmpty { return "等待当前步骤结束" }
        switch projection.currentState {
        case "waiting_input": return "回复 Agent，让任务继续"
        case "user_review": return "审阅最新结果；需要调整时追加指令"
        case "running", "reviewing": return "Agent 正在执行，无需操作"
        case "failed": return "查看失败原因并决定是否重试"
        default: return "可以继续布置任务"
        }
    }

    private var canContinue: Bool { session.cwd != nil && !session.correlationUncertain }
    private func willQueue(_ projection: TaskDetailProjection) -> Bool {
        session.activePid != nil || ["running", "waiting", "reviewing"].contains(projection.currentState)
    }
    private func duplicateActive(in projection: TaskDetailProjection) -> Bool {
        let value = followUp.trimmingCharacters(in: .whitespacesAndNewlines)
        return projection.activeQueue.contains {
            $0.text.trimmingCharacters(in: .whitespacesAndNewlines) == value
        }
    }

    private func persistFollowUpDraft() {
        let key = "zimlo.task-draft.\(session.id)"
        if followUp.isEmpty { UserDefaults.standard.removeObject(forKey: key) }
        else { UserDefaults.standard.set(followUp, forKey: key) }
    }
}

enum TaskTimelineItem: Identifiable, Hashable {
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

enum TimelineReadDelay {
    static func wait(for duration: Duration = .seconds(1)) async -> Bool {
        do {
            try await Task.sleep(for: duration)
            try Task.checkCancellation()
            return true
        } catch {
            return false
        }
    }
}

struct TaskDetailProjection {
    let project: Project?
    let posts: [FeedPost]
    let commands: [TaskCommand]
    let currentState: String
    let pendingActions: [PendingAction]
    let activeQueue: [TaskCommand]
    let latestReview: TaskReview?
    let taskInput: String
    let timelineItems: [TaskTimelineItem]
    let detailsByItemID: [String: [String]]

    init(
        snapshot: Snapshot,
        session: AgentSession,
        sessionEvents: [UnifiedEvent],
        localFollowUps: [TaskCommand]
    ) {
        project = session.projectId.flatMap { id in snapshot.projects.first { $0.id == id } }
        posts = snapshot.posts
            .filter { $0.sessionId == session.id }
            .sorted { $0.createdAt > $1.createdAt }
        commands = (localFollowUps + snapshot.commands.filter { $0.sessionId == session.id })
            .sorted { $0.createdAt > $1.createdAt }

        let task = snapshot.tasks.lazy
            .filter { $0.sessionId == session.id }
            .max { $0.updatedAt < $1.updatedAt }
        currentState = task?.state ?? session.status
        pendingActions = snapshot.actions.filter { $0.sessionId == session.id && $0.state == "pending" }
        activeQueue = commands.filter { ["queued", "dispatching", "running"].contains($0.state) }
        latestReview = snapshot.reviews.lazy
            .filter { $0.sessionId == session.id }
            .max { $0.version < $1.version }
        taskInput = sessionEvents.lazy
            .filter { $0.kind == "user_instruction" }
            .min { $0.sequence < $1.sequence }?
            .payload.stringValue ?? session.title

        var items = posts.map(TaskTimelineItem.post)
        items += commands.map(TaskTimelineItem.command)
        let commandTexts = Set(commands.map { Self.normalized($0.text) })
        items += sessionEvents.lazy
            .filter { $0.kind == "user_instruction" }
            .filter { !commandTexts.contains(Self.normalized($0.payload.stringValue ?? "")) }
            .map(TaskTimelineItem.event)
        timelineItems = items.sorted { $0.at > $1.at }
        detailsByItemID = Self.makeDetails(
            for: timelineItems,
            sessionEvents: sessionEvents
        )
    }

    private static func makeDetails(
        for items: [TaskTimelineItem],
        sessionEvents: [UnifiedEvent]
    ) -> [String: [String]] {
        let instructionDetails = makeInstructionDetails(sessionEvents)
        var firstInstructionByText: [String: UnifiedEvent] = [:]
        for event in sessionEvents where event.kind == "user_instruction" {
            let key = normalized(event.payload.stringValue ?? "")
            if firstInstructionByText[key] == nil { firstInstructionByText[key] = event }
        }

        var result: [String: [String]] = [:]
        result.reserveCapacity(items.count)
        for item in items {
            let details: [String]
            switch item {
            case .post(let post):
                details = post.highlights
                    + [post.proof].compactMap { $0 }
                    + [post.actionPrompt].compactMap { $0 }
            case .command(let command):
                if let instruction = firstInstructionByText[normalized(command.text)] {
                    details = instructionDetails[instruction.id] ?? []
                } else {
                    details = []
                }
            case .event(let instruction):
                details = instructionDetails[instruction.id] ?? []
            }
            if !details.isEmpty { result[item.id] = details }
        }
        return result
    }

    private static func makeInstructionDetails(_ events: [UnifiedEvent]) -> [String: [String]] {
        let sorted = events.sorted { $0.sequence < $1.sequence }
        var eventsByTurn: [String: [UnifiedEvent]] = [:]
        var followingEvents: [String: [UnifiedEvent]] = [:]
        var currentInstructionWithoutTurn: String?

        for event in sorted {
            if let turnID = event.turnId { eventsByTurn[turnID, default: []].append(event) }
            if event.kind == "user_instruction" {
                currentInstructionWithoutTurn = event.turnId == nil ? event.id : nil
            } else if let instructionID = currentInstructionWithoutTurn {
                followingEvents[instructionID, default: []].append(event)
            }
        }

        var result: [String: [String]] = [:]
        for instruction in sorted where instruction.kind == "user_instruction" {
            let related: [UnifiedEvent]
            if let turnID = instruction.turnId {
                related = (eventsByTurn[turnID] ?? []).filter { $0.id != instruction.id }
            } else {
                related = followingEvents[instruction.id] ?? []
            }
            let details = related.prefix(8).map(eventDetail)
            if !details.isEmpty { result[instruction.id] = details }
        }
        return result
    }

    private static func eventDetail(_ event: UnifiedEvent) -> String {
        let labels = [
            "plan_updated": "计划", "files_changed": "文件变更", "tests_passed": "验证",
            "tests_failed": "验证失败", "blocked": "受阻", "completed": "完成", "failed": "失败",
        ]
        let value = event.payload.stringValue ?? "状态已更新"
        let concise = value.count > 500 ? "\(value.prefix(500))…" : value
        return "\(labels[event.kind] ?? "执行")：\(concise)"
    }

    private static func normalized(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

private struct TimelineRow: View {
    @ObservedObject var model: AppModel
    let item: TaskTimelineItem
    let project: Project?
    let userAvatar: String
    let details: [String]
    @State private var previewURL: URL?
    @State private var materialMessage: String?

    private var commandMaterials: [Material] {
        guard case .command(let command) = item else { return [] }
        return (command.materialIds ?? []).compactMap { id in model.snapshot.materials.first { $0.id == id } }
    }

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
                if !commandMaterials.isEmpty {
                    ScrollView(.horizontal) {
                        HStack(spacing: 8) {
                            ForEach(commandMaterials) { material in
                                Button {
                                    Task {
                                        do { previewURL = try await model.localURL(for: material) }
                                        catch { materialMessage = error.localizedDescription }
                                    }
                                } label: {
                                    HStack(spacing: 7) {
                                        MaterialThumbnail(material: material, url: MaterialCache.url(for: material))
                                        Text(material.name).font(ZFont.caption).lineLimit(1)
                                    }
                                    .padding(6).padding(.trailing, 7).foregroundStyle(ZColor.ink).background(ZColor.raised)
                                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    .scrollIndicators(.hidden)
                }
                if let materialMessage { Text(materialMessage).font(ZFont.caption2).foregroundStyle(ZColor.muted) }
                if case .command(let command) = item, command.state == "failed" {
                    Button("重试") { model.retry(commandId: command.id) }
                        .font(ZFont.caption)
                        .foregroundStyle(ZColor.coralText)
                }
                if !details.isEmpty {
                    DisclosureGroup("查看 \(details.count) 项执行细节") {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(details, id: \.self) { Text("• \($0)").font(ZFont.footnote).foregroundStyle(ZColor.muted) }
                        }.padding(.top, 7)
                    }
                    .font(ZFont.caption).tint(ZColor.sageText)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16).padding(.vertical, 14)
        .overlay(alignment: .bottom) { Rectangle().fill(ZColor.line).frame(height: 1) }
        .sheet(isPresented: Binding(get: { previewURL != nil }, set: { if !$0 { previewURL = nil } })) {
            if let previewURL { QuickLookSheet(url: previewURL).ignoresSafeArea() }
        }
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
}

struct NewTaskView: View {
    @ObservedObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @AppStorage("zimlo.lastWorkspace") private var lastWorkspace = ""
    @AppStorage("zimlo.lastProvider") private var lastProvider = Provider.codex.rawValue
    @State private var text = UserDefaults.standard.string(forKey: "zimlo.newTaskDraft") ?? ""
    @State private var search = ""
    @State private var choosingAgent = false
    @State private var submitting = false
    @State private var selectedPhotos: [PhotosPickerItem] = []
    @State private var showingFileImporter = false
    @State private var preparedMaterials: [PreparedMobileMaterial] = []
    @State private var failedMaterials: [PreparedMobileMaterial] = []
    @State private var uploadsInFlight = 0
    @State private var materialError: String?

    private var materialCount: Int { preparedMaterials.count + failedMaterials.count }

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
                            HStack(spacing: 10) {
                                PhotosPicker(
                                    selection: $selectedPhotos,
                                    maxSelectionCount: max(0, MaterialPolicy.maxCount - materialCount),
                                    matching: .any(of: [.images, .videos])
                                ) {
                                    Label("照片或视频", systemImage: "photo.on.rectangle")
                                }
                                Button { showingFileImporter = true } label: {
                                    Label("文件", systemImage: "paperclip")
                                }
                                Spacer()
                                if uploadsInFlight > 0 { ProgressView().controlSize(.small) }
                                Text("\(materialCount)/\(MaterialPolicy.maxCount)")
                                    .font(ZFont.caption2).foregroundStyle(ZColor.muted)
                            }
                            .font(ZFont.caption.weight(.bold))
                            .buttonStyle(.bordered)

                            if !preparedMaterials.isEmpty {
                                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                                    ForEach(preparedMaterials) { prepared in
                                        HStack(spacing: 8) {
                                            MaterialThumbnail(material: prepared.material, url: prepared.localURL)
                                            VStack(alignment: .leading, spacing: 3) {
                                                Text(prepared.material.name).font(ZFont.caption).lineLimit(1)
                                                Text(formatBytes(prepared.material.sizeBytes)).font(ZFont.caption2).foregroundStyle(ZColor.muted)
                                            }
                                            Spacer(minLength: 0)
                                            Button {
                                                preparedMaterials.removeAll { $0.id == prepared.id }
                                            } label: { Image(systemName: "xmark.circle.fill") }
                                            .buttonStyle(.plain).foregroundStyle(ZColor.muted)
                                        }
                                        .padding(7).background(ZColor.raised)
                                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                                    }
                                }
                            }
                            if !failedMaterials.isEmpty {
                                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                                    ForEach(failedMaterials) { prepared in
                                        VStack(alignment: .leading, spacing: 7) {
                                            HStack(spacing: 8) {
                                                MaterialThumbnail(material: prepared.material, url: prepared.localURL)
                                                VStack(alignment: .leading, spacing: 3) {
                                                    Text(prepared.material.name).font(ZFont.caption).lineLimit(1)
                                                    Text("上传未完成").font(ZFont.caption2).foregroundStyle(ZColor.coralText)
                                                }
                                                Spacer(minLength: 0)
                                                Button {
                                                    failedMaterials.removeAll { $0.id == prepared.id }
                                                } label: { Image(systemName: "xmark.circle.fill") }
                                                .buttonStyle(.plain).foregroundStyle(ZColor.muted)
                                            }
                                            Button("重试上传") { Task { await retryMaterial(prepared) } }
                                                .font(ZFont.caption.weight(.bold))
                                                .buttonStyle(.bordered)
                                                .disabled(uploadsInFlight > 0)
                                        }
                                        .padding(7).background(ZColor.coral.opacity(0.07))
                                        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(ZColor.coral.opacity(0.28)))
                                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                                    }
                                }
                            }
                            if let materialError {
                                Text(materialError).font(ZFont.caption2).foregroundStyle(ZColor.coralText)
                            }
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
                                    Text(choosingAgent ? "收起" : "更换").font(ZFont.caption2).foregroundStyle(ZColor.sageText)
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
                                                        Image(systemName: "checkmark").font(ZFont.caption).foregroundStyle(ZColor.sageText)
                                                    }
                                                }
                                                .padding(.horizontal, 10).padding(.vertical, 8)
                                                .foregroundStyle(ZColor.ink)
                                                .background(workspace.id == lastWorkspace ? ZColor.acid.opacity(0.18) : ZColor.raised)
                                            }
                                            .buttonStyle(.plain)
                                            Divider()
                                        }
                                    }
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
                                                .background(lastProvider == provider.rawValue ? ZColor.acid.opacity(0.18) : Color.clear)
                                                .overlay(Capsule().stroke(lastProvider == provider.rawValue ? ZColor.acid : ZColor.line))
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
                                .font(ZFont.footnote).foregroundStyle(ZColor.coralText)
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
                        let didPersist = model.createTask(
                            provider: selectedProvider,
                            workspaceId: lastWorkspace,
                            text: text.trimmingCharacters(in: .whitespacesAndNewlines),
                            materialIds: preparedMaterials.map(\.id)
                        )
                        if didPersist {
                            text = ""
                            UserDefaults.standard.removeObject(forKey: "zimlo.newTaskDraft")
                            dismiss()
                        } else {
                            submitting = false
                        }
                    } label: {
                        HStack { Text("开始任务"); Image(systemName: "arrow.right") }
                    }
                    .buttonStyle(ActionButtonStyle(primary: true))
                    .frame(width: 142)
                    .disabled(submitting || uploadsInFlight > 0 || !failedMaterials.isEmpty || lastWorkspace.isEmpty || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
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
            .fileImporter(
                isPresented: $showingFileImporter,
                allowedContentTypes: [.pdf, .plainText, .commaSeparatedText, .json, .image, .movie, .data],
                allowsMultipleSelection: true
            ) { result in
                guard case .success(let urls) = result else { return }
                Task { await addFiles(urls) }
            }
            .onChange(of: selectedPhotos) { _, items in
                guard !items.isEmpty else { return }
                Task {
                    for item in items {
                        guard let data = try? await item.loadTransferable(type: Data.self) else {
                            materialError = "无法读取所选照片或视频"
                            continue
                        }
                        let type = item.supportedContentTypes.first ?? .jpeg
                        let ext = type.preferredFilenameExtension ?? (type.conforms(to: .movie) ? "mov" : "jpg")
                        await addMaterial(data: data, name: "素材.\(ext)", mimeType: type.preferredMIMEType ?? "application/octet-stream")
                    }
                    selectedPhotos = []
                }
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
            .task(id: text) {
                try? await Task.sleep(for: .milliseconds(350))
                guard !Task.isCancelled else { return }
                persistTaskDraft()
            }
            .onDisappear { persistTaskDraft() }
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

    private func persistTaskDraft() {
        if text.isEmpty { UserDefaults.standard.removeObject(forKey: "zimlo.newTaskDraft") }
        else { UserDefaults.standard.set(text, forKey: "zimlo.newTaskDraft") }
    }

    private func addFiles(_ urls: [URL]) async {
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            do {
                let values = try url.resourceValues(forKeys: [.contentTypeKey])
                let data = try Data(contentsOf: url, options: .mappedIfSafe)
                await addMaterial(
                    data: data, name: url.lastPathComponent,
                    mimeType: values.contentType?.preferredMIMEType ?? "application/octet-stream"
                )
            } catch {
                materialError = "无法读取 \(url.lastPathComponent)"
            }
        }
    }

    private func addMaterial(data: Data, name: String, mimeType: String) async {
        guard materialCount + uploadsInFlight < MaterialPolicy.maxCount else {
            materialError = "每个任务最多添加 \(MaterialPolicy.maxCount) 个物料"
            return
        }
        let currentBytes = (preparedMaterials + failedMaterials).reduce(0) { $0 + $1.material.sizeBytes }
        guard currentBytes + data.count <= MaterialPolicy.maxTotalBytes else {
            materialError = "单个任务的物料总大小不能超过 80MB"
            return
        }
        uploadsInFlight += 1
        materialError = nil
        defer { uploadsInFlight -= 1 }
        var prepared: PreparedMobileMaterial?
        do {
            let value = try await MaterialPolicy.prepare(data: data, name: name, mimeType: mimeType)
            prepared = value
            _ = try await model.uploadAndRegister(value)
            preparedMaterials.append(value)
        } catch {
            if let prepared, !failedMaterials.contains(where: { $0.id == prepared.id }) {
                failedMaterials.append(prepared)
            }
            materialError = error.localizedDescription
        }
    }

    private func retryMaterial(_ prepared: PreparedMobileMaterial) async {
        guard uploadsInFlight == 0 else { return }
        uploadsInFlight += 1
        materialError = nil
        defer { uploadsInFlight -= 1 }
        do {
            _ = try await model.uploadAndRegister(prepared)
            failedMaterials.removeAll { $0.id == prepared.id }
            if !preparedMaterials.contains(where: { $0.id == prepared.id }) {
                preparedMaterials.append(prepared)
            }
        } catch {
            materialError = error.localizedDescription
        }
    }

    private func formatBytes(_ bytes: Int) -> String {
        if bytes >= 1_024 * 1_024 { return String(format: "%.1fMB", Double(bytes) / 1_024 / 1_024) }
        return "\(max(1, bytes / 1_024))KB"
    }
}
