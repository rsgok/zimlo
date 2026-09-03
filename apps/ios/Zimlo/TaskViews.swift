import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct TaskDetailView: View {
    @ObservedObject var model: AppModel
    let session: AgentSession
    var body: some View {
        let projection = TaskDetailProjection(
            snapshot: model.snapshot,
            session: session,
            sessionEvents: model.events[session.id] ?? [],
            localFollowUps: model.localFollowUps(session: session)
        )
        let latestTimelineItemID = projection.timelineItems.first?.id

        return ScrollView {
            LazyVStack(spacing: 0) {
                compactHeader(projection)
                if !projection.pendingActions.isEmpty { attentionSection(projection.pendingActions) }
                timeline(projection)
            }
        }
        .scrollIndicators(.hidden)
        .background(ZColor.paper)
        .zPageSurface()
        .task(id: latestTimelineItemID) {
            guard let latest = latestTimelineItemID,
                  model.snapshot.taskTimelineCursors[session.id] != latest else { return }
            guard await TimelineReadDelay.wait() else { return }
            guard model.snapshot.taskTimelineCursors[session.id] != latest else { return }
            model.markTimelineSeen(sessionId: session.id, itemId: latest)
        }
    }

    private func compactHeader(_ projection: TaskDetailProjection) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                AgentAvatar(value: projection.project?.agentProfile.avatar ?? "Z", size: 42)
                VStack(alignment: .leading, spacing: 2) {
                    Text(projection.project?.agentProfile.displayName ?? session.provider.label).font(ZFont.headline)
                    HStack(spacing: 6) {
                        ProviderBadge(provider: session.provider, surface: session.surface)
                        Text(session.projectName ?? session.cwd?.split(separator: "/").last.map(String.init) ?? "未归属")
                            .font(ZFont.footnote).foregroundStyle(ZColor.secondaryInk).lineLimit(1)
                    }
                }
            }
            VStack(alignment: .leading, spacing: 7) {
                Text("原始任务").font(ZFont.caption).foregroundStyle(ZColor.secondaryInk)
                Text(projection.taskInput)
                    .font(ZFont.body.weight(.semibold))
                    .foregroundStyle(ZColor.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let latest = projection.posts.first {
                latestConclusion(latest)
            }
            if let action = TaskHeaderRules.requiredAction(
                currentState: projection.currentState,
                pendingActionTitle: projection.pendingActions.first?.title,
                hasLatestConclusion: !projection.posts.isEmpty
            ) {
                requiredAction(action)
            }
        }
        .foregroundStyle(ZColor.ink)
        .padding(.horizontal, 18).padding(.top, 18).padding(.bottom, 20)
        .overlay(alignment: .bottom) { Rectangle().fill(ZColor.line).frame(height: 1) }
    }

    private func latestConclusion(_ post: FeedPost) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("最新结论", systemImage: "sparkles")
                .font(ZFont.caption)
                .foregroundStyle(ZColor.sageText)
            Text(post.headline)
                .font(ZFont.title3)
                .foregroundStyle(ZColor.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ZColor.raised)
        .overlay(
            RoundedRectangle(cornerRadius: ZRadius.inner, style: .continuous)
                .stroke(ZColor.sageText.opacity(0.34))
        )
        .clipShape(RoundedRectangle(cornerRadius: ZRadius.inner, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    private func requiredAction(_ action: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "arrow.turn.down.right")
                .font(ZFont.callout.weight(.bold))
                .foregroundStyle(ZColor.coralText)
            VStack(alignment: .leading, spacing: 3) {
                Text("需要你").font(ZFont.caption).foregroundStyle(ZColor.coralText)
                Text(action).font(ZFont.callout.weight(.bold)).foregroundStyle(ZColor.ink)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ZColor.coral.opacity(0.13))
        .overlay(
            RoundedRectangle(cornerRadius: ZRadius.control, style: .continuous)
                .stroke(ZColor.coralText.opacity(0.28))
        )
        .clipShape(RoundedRectangle(cornerRadius: ZRadius.control, style: .continuous))
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
        taskInput = Self.originalInput(sessionTitle: session.title, sessionEvents: sessionEvents)

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

    static func originalInput(sessionTitle: String, sessionEvents: [UnifiedEvent]) -> String {
        sessionEvents.lazy
            .filter { $0.kind == "user_instruction" }
            .min { $0.sequence < $1.sequence }?
            .payload.stringValue ?? sessionTitle
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
    let session: AgentSession?
    @Environment(\.dismiss) private var dismiss
    @AppStorage("zimlo.lastWorkspace") private var lastWorkspace = ""
    @AppStorage("zimlo.lastProvider") private var lastProvider = Provider.codex.rawValue
    @State private var text: String
    @State private var search = ""
    @State private var choosingAgent = false
    @State private var submitting = false
    @State private var selectedPhotos: [PhotosPickerItem] = []
    @State private var showingFileImporter = false
    @State private var preparedMaterials: [PreparedMobileMaterial] = []
    @State private var failedMaterials: [PreparedMobileMaterial] = []
    @State private var uploadsInFlight = 0
    @State private var materialError: String?
    @State private var voiceNotice: String?

    init(model: AppModel, session: AgentSession? = nil) {
        self.model = model
        self.session = session
        let key = session.map { "zimlo.task-draft.\($0.id)" } ?? "zimlo.newTaskDraft"
        _text = State(initialValue: UserDefaults.standard.string(forKey: key) ?? "")
    }

    private var draftKey: String { session.map { "zimlo.task-draft.\($0.id)" } ?? "zimlo.newTaskDraft" }

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

    private var contextProject: Project? {
        let id = session?.projectId ?? model.newTaskProjectId
        if let id, let project = model.snapshot.projects.first(where: { $0.id == id }) { return project }
        guard let cwd = session?.cwd else { return nil }
        return model.snapshot.projects.first { project in project.paths.contains(where: { cwd == $0 || cwd.hasPrefix($0 + "/") }) }
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
                    VStack(alignment: .leading, spacing: session == nil ? 18 : 12) {
                        VStack(alignment: .leading, spacing: 9) {
                            if let session {
                                HStack(spacing: 9) {
                                    AgentAvatar(value: contextProject?.agentProfile.avatar ?? "●", size: 30)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text("发送到当前会话")
                                            .font(ZFont.caption.weight(.bold))
                                        HStack(spacing: 5) {
                                            Text(contextProject?.agentProfile.displayName ?? "Agent")
                                            Text("·")
                                            Text(session.title)
                                            ProviderBadge(provider: session.provider, iconOnly: true)
                                        }
                                        .font(ZFont.caption2).foregroundStyle(ZColor.muted).lineLimit(1)
                                    }
                                    Spacer(minLength: 0)
                                }
                                .padding(.horizontal, 2)
                            } else {
                                HStack {
                                    Text("任务内容").font(ZFont.headline)
                                    Spacer()
                                    Text(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "草稿自动保存" : "草稿已保存")
                                        .font(ZFont.caption2).foregroundStyle(ZColor.muted)
                                }
                            }
                            HStack(alignment: .center, spacing: 8) {
                                Menu {
                                    PhotosPicker(
                                    selection: $selectedPhotos,
                                    maxSelectionCount: max(0, MaterialPolicy.maxCount - materialCount),
                                    matching: .any(of: [.images, .videos])
                                    ) { Label("照片或视频", systemImage: "photo.on.rectangle") }
                                    Button { showingFileImporter = true } label: { Label("文件", systemImage: "doc") }
                                } label: {
                                    Image(systemName: "paperclip")
                                        .font(.system(size: 18, weight: .bold))
                                        .frame(width: 44, height: 44)
                                        .background(ZColor.control)
                                        .clipShape(Circle())
                                }
                                .disabled(materialCount >= MaterialPolicy.maxCount)
                                VoiceInput(
                                    text: $text,
                                    placeholder: session == nil ? "描述目标，或点按麦克风…" : "回复当前会话…",
                                    axis: .horizontal,
                                    minHeight: 44,
                                    onError: { message in
                                        withAnimation(.easeOut(duration: 0.18)) { voiceNotice = message }
                                    }
                                )
                                Button { submit() } label: {
                                    Image(systemName: "arrow.up")
                                        .font(.system(size: 18, weight: .black))
                                        .frame(width: 44, height: 44)
                                        .foregroundStyle(ZColor.onAccent)
                                        .background(canSubmit ? ZColor.acid : ZColor.control)
                                        .clipShape(Circle())
                                }
                                .disabled(!canSubmit)
                                .accessibilityLabel(session == nil ? "开始任务" : "发送消息")
                            }
                            .buttonStyle(.plain)
                            if materialCount > 0 || uploadsInFlight > 0 {
                                HStack {
                                    Text("附件")
                                    Spacer()
                                    if uploadsInFlight > 0 { ProgressView().controlSize(.small) }
                                    Text("\(materialCount)/\(MaterialPolicy.maxCount)")
                                }
                                .font(ZFont.caption2).foregroundStyle(ZColor.muted)
                            }

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
                        }

                        if session == nil { VStack(alignment: .leading, spacing: 9) {
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
                        } }

                        if session == nil && model.snapshot.workspaces.isEmpty {
                            Text("先在运行设备的 Codex 或 Claude Code 中打开一次项目，Zimlo 才能安全地把任务交给它。")
                                .font(ZFont.footnote).foregroundStyle(ZColor.coralText)
                        }
                    }
                    .padding(session == nil ? 20 : 16)
                }

            }
            .foregroundStyle(ZColor.ink).background(ZColor.paper)
            .navigationTitle(session == nil ? "新任务" : "回复")
            .navigationBarTitleDisplayMode(.inline)
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
            .overlay(alignment: .top) {
                if let voiceNotice {
                    Text(voiceNotice)
                        .font(ZFont.caption.weight(.semibold))
                        .foregroundStyle(ZColor.ink)
                        .padding(.horizontal, 14).padding(.vertical, 10)
                        .background(.ultraThinMaterial)
                        .overlay(Capsule().stroke(ZColor.coral.opacity(0.45)))
                        .clipShape(Capsule())
                        .padding(.top, 8)
                        .transition(.move(edge: .top).combined(with: .opacity))
                        .task(id: voiceNotice) {
                            try? await Task.sleep(for: .seconds(4))
                            guard !Task.isCancelled else { return }
                            withAnimation(.easeIn(duration: 0.16)) { self.voiceNotice = nil }
                        }
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

    private var canSubmit: Bool {
        !submitting && uploadsInFlight == 0 && failedMaterials.isEmpty
            && (session != nil || !lastWorkspace.isEmpty)
            && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func submit() {
        guard canSubmit else { return }
        submitting = true
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let materialIds = preparedMaterials.map(\.id)
        let didPersist = session.map { model.followUp(sessionId: $0.id, text: value, materialIds: materialIds) }
            ?? model.createTask(provider: selectedProvider, workspaceId: lastWorkspace, text: value, materialIds: materialIds)
        if didPersist {
            text = ""
            UserDefaults.standard.removeObject(forKey: draftKey)
            dismiss()
        } else {
            submitting = false
        }
    }

    private func persistTaskDraft() {
        if text.isEmpty { UserDefaults.standard.removeObject(forKey: draftKey) }
        else { UserDefaults.standard.set(text, forKey: draftKey) }
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
            _ = try await model.uploadAndRegister(value, hostId: targetHostId)
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
            _ = try await model.uploadAndRegister(prepared, hostId: targetHostId)
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

    private var targetHostId: String? {
        session?.hostId ?? model.snapshot.workspaces.first(where: { $0.id == lastWorkspace })?.hostId
    }
}
