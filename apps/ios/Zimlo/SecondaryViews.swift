import SwiftUI
import UIKit

private func collapsedDirectorySessions(_ sessions: [AgentSession]) -> [AgentSession] {
    var seenProcessGroups = Set<String>()
    var result: [AgentSession] = []
    for session in sessions.sorted(by: { $0.createdAt == $1.createdAt ? $0.id < $1.id : $0.createdAt < $1.createdAt }) {
        if session.providerSessionId.hasPrefix("process:") {
            let key = "\(session.provider.rawValue):\(session.cwd ?? "unknown")"
            guard !seenProcessGroups.contains(key) else { continue }
            seenProcessGroups.insert(key)
        }
        result.append(session)
    }
    return result
}

struct TaskDirectoryRowProjection: Identifiable {
    let session: AgentSession
    let state: String
    let priority: Int
    let title: String
    let projectName: String
    let pinned: Bool
    let archived: Bool
    let ready: Bool

    var id: String { session.id }
}

struct TaskDirectorySection: Identifiable {
    let id: String
    let hint: String
    let rows: [TaskDirectoryRowProjection]
}

struct TaskDirectoryProjection {
    let sections: [TaskDirectorySection]

    init(snapshot: Snapshot, search: String, filter: String) {
        var taskBySession: [String: TaskRecord] = [:]
        for task in snapshot.tasks {
            guard let sessionID = task.sessionId else { continue }
            if let current = taskBySession[sessionID], current.updatedAt > task.updatedAt { continue }
            taskBySession[sessionID] = task
        }

        var preferenceBySession: [String: TaskPreference] = [:]
        for preference in snapshot.taskPreferences {
            preferenceBySession[preference.sessionId] = preference
        }
        var projectByID: [String: Project] = [:]
        for project in snapshot.projects {
            projectByID[project.id] = project
        }

        let rows = collapsedDirectorySessions(snapshot.sessions).map { session in
            let task = session.correlationUncertain ? nil : taskBySession[session.id]
            let state = task?.state ?? session.status
            let priority = Self.statePriority(state)
            let generatedTitle = session.title.hasPrefix("Codex ·") || session.title.hasPrefix("Claude ·")
            let reason = task?.reason.trimmingCharacters(in: CharacterSet(charactersIn: "。"))
            let title: String
            if generatedTitle, let reason, !reason.isEmpty, reason.count <= 100 {
                title = reason
            } else {
                title = session.title
            }
            let projectName = session.projectName
                ?? session.projectId.flatMap { projectByID[$0]?.name }
                ?? session.cwd?.split(separator: "/").last.map(String.init)
                ?? "未归属"
            let preference = preferenceBySession[session.id]

            return TaskDirectoryRowProjection(
                session: session,
                state: state,
                priority: priority,
                title: title,
                projectName: projectName,
                pinned: preference?.pinnedAt != nil,
                archived: preference?.archivedAt != nil,
                ready: priority >= 2 && (
                    session.capabilities.resumable || session.capabilities.replyable || state == "idle"
                )
            )
        }

        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        let showingArchived = filter == "已归档"
        let filteredRows = rows.filter { row in
            guard row.archived == showingArchived else { return false }
            let matchesSearch = query.isEmpty
                || row.title.localizedCaseInsensitiveContains(query)
                || row.projectName.localizedCaseInsensitiveContains(query)
                || row.session.cwd?.localizedCaseInsensitiveContains(query) == true
            guard matchesSearch else { return false }
            switch filter {
            case "待我处理": return row.priority == 0
            case "进行中": return row.priority == 1
            case "可继续": return row.ready
            default: return true
            }
        }
        .sorted { left, right in
            if !showingArchived, left.pinned != right.pinned { return left.pinned }
            if !showingArchived, left.priority != right.priority { return left.priority < right.priority }
            if left.session.lastActivityAt != right.session.lastActivityAt {
                return left.session.lastActivityAt > right.session.lastActivityAt
            }
            return left.id < right.id
        }

        if showingArchived {
            sections = filteredRows.isEmpty
                ? []
                : [TaskDirectorySection(id: "已归档", hint: "右滑可取消归档", rows: filteredRows)]
            return
        }

        var groupedRows = Array(repeating: [TaskDirectoryRowProjection](), count: 3)
        for row in filteredRows {
            groupedRows[min(row.priority, 2)].append(row)
        }
        let definitions = [
            ("待你处理", "回复、审阅或恢复"),
            ("正在工作", "Agent 正在推进"),
            ("可继续与最近完成", "随时回看或继续"),
        ]
        sections = definitions.enumerated().compactMap { index, definition in
            let rows = groupedRows[index]
            return rows.isEmpty
                ? nil
                : TaskDirectorySection(id: definition.0, hint: definition.1, rows: rows)
        }
    }

    private static func statePriority(_ state: String) -> Int {
        switch state {
        case "waiting", "waiting_input", "user_review", "failed": return 0
        case "running", "reviewing": return 1
        default: return 2
        }
    }
}

private struct AgentDirectoryRow: Identifiable {
    let project: Project
    let activeCount: Int
    var id: String { project.id }
}

struct TasksDirectoryView: View {
    @ObservedObject var model: AppModel
    @State private var search = ""
    @State private var filter = "全部"
    @State private var showingSearch = false
    private let filters = ["全部", "待我处理", "进行中", "可继续", "已归档"]

    var body: some View {
        let sections = TaskDirectoryProjection(
            snapshot: model.snapshot,
            search: search,
            filter: filter
        ).sections
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                ZFilterBar(
                    options: filters,
                    selection: $filter,
                    searchExpanded: showingSearch,
                    toggleSearch: { withAnimation(.easeInOut(duration: 0.18)) { showingSearch.toggle() } }
                )
                if showingSearch {
                    TextField("搜索任务或项目", text: $search)
                        .foregroundStyle(ZColor.ink)
                        .tint(ZColor.sageText)
                        .padding(.horizontal, 12).frame(height: 42)
                        .background(ZColor.raised)
                        .overlay(RoundedRectangle(cornerRadius: ZRadius.control, style: .continuous).stroke(ZColor.line))
                        .clipShape(RoundedRectangle(cornerRadius: ZRadius.control, style: .continuous))
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 10)

            List {
                ForEach(sections) { section in
                    Section {
                        ForEach(section.rows) { row in
                            taskRow(row)
                                .listRowInsets(EdgeInsets(top: 5, leading: 14, bottom: 5, trailing: 14))
                                .listRowSeparator(.hidden)
                                .listRowBackground(ZColor.paper)
                                .swipeActions(edge: .leading, allowsFullSwipe: false) {
                                    Button { model.setPinned(sessionId: row.id, pinned: !row.pinned) } label: {
                                        Label(row.pinned ? "取消置顶" : "置顶", systemImage: row.pinned ? "pin.slash" : "pin")
                                    }.tint(ZColor.sage)
                                }
                                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                    if filter == "已归档" {
                                        Button { model.setArchived(sessionId: row.id, archived: false, offerUndo: false) } label: {
                                            Label("取消归档", systemImage: "tray.and.arrow.up")
                                        }.tint(ZColor.sage)
                                    } else {
                                        Button { model.setArchived(sessionId: row.id, archived: true) } label: {
                                            Label("归档", systemImage: "archivebox")
                                        }.tint(ZColor.coral)
                                    }
                                }
                        }
                    } header: {
                        HStack {
                            Text(section.id).font(ZFont.subheadline.weight(.black))
                            Spacer()
                            Text("\(section.rows.count) · \(section.hint)").font(ZFont.caption2).foregroundStyle(ZColor.muted)
                        }
                        .textCase(nil)
                        .padding(.vertical, 6)
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .scrollIndicators(.hidden)
            .background(ZColor.paper)
            .overlay {
                if sections.isEmpty {
                    VStack(spacing: 10) {
                        Image(systemName: filter == "已归档" ? "archivebox" : "checklist")
                            .font(ZFont.title2).foregroundStyle(ZColor.sageText)
                        Text(filter == "已归档" ? "还没有归档任务" : "没有符合条件的任务")
                            .font(ZFont.headline)
                        Text(showingSearch || !search.isEmpty ? "换个关键词或筛选条件试试。" : "新任务创建后会按下一步动作自动归类。")
                            .font(ZFont.footnote).foregroundStyle(ZColor.muted)
                    }
                    .multilineTextAlignment(.center)
                    .padding(24)
                }
            }
        }
        .zPageSurface()
    }

    private func taskRow(_ row: TaskDirectoryRowProjection) -> some View {
        Button { model.openTask(sessionId: row.id) } label: {
            HStack(spacing: 12) {
                ProviderBadge(provider: row.session.provider, iconOnly: true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(row.title).font(ZFont.subheadline.weight(.bold)).lineLimit(2)
                    HStack(spacing: 6) {
                        Text(row.projectName)
                            .font(ZFont.caption2).foregroundStyle(ZColor.muted).lineLimit(1)
                        TimelineView(.periodic(from: .now, by: 30)) { _ in
                            Text("· \(relative(row.session.lastActivityAt))")
                                .font(ZFont.caption2).foregroundStyle(ZColor.muted)
                        }
                    }
                    if let nextStep = nextStep(row.state) {
                        Text(nextStep).font(ZFont.caption2)
                            .foregroundStyle(row.priority == 0 ? ZColor.coralText : ZColor.sageText)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                Text(stateLabel(row.state)).font(ZFont.caption2)
                    .foregroundStyle(statusColor(row.state))
                    .padding(.horizontal, 7).padding(.vertical, 5)
                    .background(statusColor(row.state).opacity(0.11))
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            }
            .foregroundStyle(ZColor.ink)
            .padding(14)
            .background(ZColor.raised)
            .overlay(RoundedRectangle(cornerRadius: ZRadius.inner, style: .continuous).stroke(ZColor.line))
            .clipShape(RoundedRectangle(cornerRadius: ZRadius.inner, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private func stateLabel(_ state: String) -> String {
        ["running": "进行中", "waiting": "等待中", "idle": "可继续", "completed": "已完成",
         "failed": "失败", "ended": "已结束", "waiting_input": "等你回复",
         "reviewing": "检查中", "user_review": "待你审阅"][state] ?? "状态未知"
    }

    private func nextStep(_ state: String) -> String? {
        switch state {
        case "waiting", "waiting_input": return "需要你的回复"
        case "user_review": return "结果已就绪，等待你审阅"
        case "failed": return "查看原因和恢复方式"
        case "running", "reviewing": return "Agent 正在执行"
        case "idle": return "可以继续布置后续工作"
        default: return nil
        }
    }

    private func statusColor(_ state: String) -> Color {
        if ["failed", "waiting", "waiting_input", "user_review"].contains(state) { return ZColor.coralText }
        if ["running", "reviewing"].contains(state) { return ZColor.sageText }
        return ZColor.muted
    }

}

struct AgentsDirectoryView: View {
    @ObservedObject var model: AppModel
    @State private var search = ""
    @State private var filter = "已启用"
    @State private var showingSearch = false
    private let filters = ["已启用", "工作中", "全部"]

    var body: some View {
        let rows = agentRows
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                ZFilterBar(
                    options: filters,
                    selection: $filter,
                    searchExpanded: showingSearch,
                    toggleSearch: { withAnimation(.easeInOut(duration: 0.18)) { showingSearch.toggle() } }
                )
                if showingSearch {
                    TextField("搜索 Agent 或项目", text: $search)
                        .foregroundStyle(ZColor.ink)
                        .tint(ZColor.sageText)
                        .padding(.horizontal, 12).frame(height: 42)
                        .background(ZColor.raised)
                        .overlay(RoundedRectangle(cornerRadius: ZRadius.control, style: .continuous).stroke(ZColor.line))
                        .clipShape(RoundedRectangle(cornerRadius: ZRadius.control, style: .continuous))
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            ScrollView {
                LazyVStack(spacing: 12) {
                    ForEach(rows) { row in
                        let project = row.project
                        HStack(spacing: 0) {
                            Button { model.openAgent(projectId: project.id) } label: {
                                HStack(alignment: .top, spacing: 13) {
                                    ZStack(alignment: .bottomTrailing) {
                                        AgentAvatar(value: project.agentProfile.avatar, size: 52)
                                        Circle().fill(row.activeCount > 0 ? ZColor.sage : ZColor.muted)
                                            .frame(width: 11, height: 11).overlay(Circle().stroke(ZColor.paper, lineWidth: 3))
                                    }
                                    VStack(alignment: .leading, spacing: 6) {
                                        HStack {
                                            Text(project.agentProfile.displayName).font(ZFont.headline).lineLimit(1)
                                            Spacer()
                                            Text(row.activeCount > 0 ? "\(row.activeCount) 个进行中" : project.sessionCount > 0 ? "随时可用" : "尚未启用")
                                                .font(ZFont.caption2).foregroundStyle(row.activeCount > 0 ? ZColor.sageText : ZColor.muted)
                                        }
                                        if let bio = agentBio(project) {
                                            Text(bio).font(ZFont.footnote)
                                                .foregroundStyle(ZColor.ink.opacity(0.72)).lineLimit(2)
                                        }
                                        HStack(spacing: 5) {
                                            Text(project.name)
                                            Text("· \(project.sessionCount) 个任务")
                                            TimelineView(.periodic(from: .now, by: 30)) { _ in
                                                Text("· \(relative(project.lastUsedAt))")
                                            }
                                        }
                                        .font(ZFont.caption2).foregroundStyle(ZColor.muted).lineLimit(1)
                                        if let provider = project.agentProfile.defaultProvider {
                                            HStack(spacing: 5) {
                                                ProviderBadge(provider: provider, iconOnly: true)
                                                Text("默认 Runtime")
                                            }.font(ZFont.caption2).foregroundStyle(ZColor.muted)
                                        } else if !project.providers.isEmpty {
                                            HStack(spacing: 5) {
                                                ForEach(project.providers, id: \.rawValue) { provider in
                                                    ProviderBadge(provider: provider, iconOnly: true)
                                                }
                                                Text("可用 Runtime")
                                            }.font(ZFont.caption2).foregroundStyle(ZColor.muted)
                                        } else {
                                            Text("Runtime 自动选择").font(ZFont.caption2).foregroundStyle(ZColor.muted)
                                        }
                                    }
                                }
                                .padding(14).frame(maxWidth: .infinity, alignment: .leading)
                                .foregroundStyle(ZColor.ink)
                            }
                            Button {
                                model.newTaskProjectId = project.id
                                model.showingNewTask = true
                            } label: {
                                VStack(spacing: 5) {
                                    Image(systemName: "plus").font(ZFont.callout.weight(.black))
                                    Text("新任务").font(ZFont.caption2)
                                }
                                .foregroundStyle(ZColor.sageText).frame(width: 62).frame(maxHeight: .infinity)
                                .background(ZColor.acid.opacity(0.14))
                            }
                        }
                        .background(ZColor.raised)
                        .overlay(RoundedRectangle(cornerRadius: ZRadius.inner, style: .continuous).stroke(ZColor.line))
                        .clipShape(RoundedRectangle(cornerRadius: ZRadius.inner, style: .continuous))
                    }
                }.padding(12)
            }.scrollIndicators(.hidden)
        }
        .zPageSurface()
    }

    private func agentBio(_ project: Project) -> String? {
        let value = project.agentProfile.bio.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty || value == "负责 \(project.name) 项目的长期工作与上下文。" { return nil }
        return value
    }

    private var agentRows: [AgentDirectoryRow] {
        let counts = Dictionary(
            grouping: collapsedDirectorySessions(model.snapshot.sessions).filter { $0.status == "running" },
            by: { $0.projectId ?? "" }
        ).mapValues(\.count)
        return model.snapshot.projects
            .compactMap { project -> AgentDirectoryRow? in
                let activeCount = counts[project.id] ?? 0
                if filter == "已启用" && project.sessionCount == 0 { return nil }
                if filter == "工作中" && activeCount == 0 { return nil }
                guard search.isEmpty
                    || project.agentProfile.displayName.localizedCaseInsensitiveContains(search)
                    || project.name.localizedCaseInsensitiveContains(search) else { return nil }
                return AgentDirectoryRow(project: project, activeCount: activeCount)
            }
            .sorted { left, right in
                let activeDifference = left.activeCount - right.activeCount
                if activeDifference != 0 { return activeDifference > 0 }
                if left.project.lastUsedAt != right.project.lastUsedAt { return left.project.lastUsedAt > right.project.lastUsedAt }
                return left.project.agentProfile.displayName.localizedStandardCompare(right.project.agentProfile.displayName) == .orderedAscending
            }
    }
}

struct AgentDetailProjection {
    let managedSessions: [AgentSession]
    let posts: [FeedPost]
    let visiblePosts: [FeedPost]
    let runningCount: Int
    let remainingPostCount: Int
    let workspacePaths: [String]
    let visibleBio: String?
    let trustPolicy: ProjectTrustPolicy?
    let trustAudit: [TrustAuditEntry]

    init(snapshot: Snapshot, project: Project, showAllActivity: Bool) {
        let projectSessions = snapshot.sessions.filter { $0.projectId == project.id }
        let managedSessions = collapsedDirectorySessions(projectSessions)
        self.managedSessions = managedSessions
        runningCount = managedSessions.lazy.filter { $0.status == "running" }.count

        let posts = snapshot.posts
            .filter { $0.projectId == project.id }
            .sorted {
                if $0.createdAt != $1.createdAt { return $0.createdAt > $1.createdAt }
                return $0.id < $1.id
            }
        self.posts = posts
        let visiblePosts = showAllActivity ? posts : Array(posts.prefix(8))
        self.visiblePosts = visiblePosts
        remainingPostCount = max(0, posts.count - visiblePosts.count)

        var seenPaths = Set<String>()
        workspacePaths = ([project.primaryPath] + project.paths)
            .filter { !$0.isEmpty && seenPaths.insert($0).inserted }

        let bio = project.agentProfile.bio.trimmingCharacters(in: .whitespacesAndNewlines)
        visibleBio = bio.isEmpty || bio == "负责 \(project.name) 项目的长期工作与上下文。" ? nil : bio
        trustPolicy = snapshot.trustPolicies.first { $0.projectId == project.id }
        trustAudit = Array(snapshot.trustAudit.lazy.filter { $0.projectId == project.id }.prefix(3))
    }
}

struct AgentDetailView: View {
    @ObservedObject var model: AppModel
    let project: Project
    @State private var editing = false
    @State private var showAllActivity = false
    @State private var copiedWorkspacePath: String?

    var body: some View {
        let projection = AgentDetailProjection(
            snapshot: model.snapshot,
            project: project,
            showAllActivity: showAllActivity
        )
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(alignment: .top, spacing: 14) {
                        AgentAvatar(value: project.agentProfile.avatar, size: 70)
                        VStack(alignment: .leading, spacing: 5) {
                            Text(project.agentProfile.displayName).font(ZFont.title)
                            Text(project.name).font(ZFont.footnote.weight(.semibold)).foregroundStyle(ZColor.muted)
                            Text(projection.visibleBio ?? "还没有设置专长与工作方式。编辑资料后，更容易理解这个 Agent 适合做什么。")
                                .font(ZFont.subheadline)
                                .foregroundStyle(projection.visibleBio == nil ? ZColor.muted : ZColor.ink).lineLimit(3)
                        }
                    }.padding(18)
                    HStack {
                        Button { model.newTaskProjectId = project.id; model.showingNewTask = true } label: {
                            Label("新任务", systemImage: "plus")
                        }.buttonStyle(ActionButtonStyle(primary: true))
                        Button { editing = true } label: {
                            Label("编辑资料", systemImage: "pencil")
                        }.buttonStyle(ActionButtonStyle(role: .neutral))
                    }
                    .padding(.horizontal, 18).padding(.bottom, 12)
                    HStack {
                        metric(projection.runningCount > 0 ? "\(projection.runningCount)" : "空闲", "正在工作")
                        metric("\(project.sessionCount)", "历史任务")
                        metric(project.agentProfile.defaultProvider?.label ?? "自动", "默认 Runtime")
                    }
                    .padding(.horizontal, 18).padding(.bottom, 14)
                    if !projection.workspacePaths.isEmpty { workspaceSection(projection.workspacePaths) }
                    if model.snapshot.features.projectTrustPolicy {
                        trustSection(policy: projection.trustPolicy, audit: projection.trustAudit)
                    }
                    Rectangle().fill(ZColor.line).frame(height: 1)
                    HStack {
                        Text("重要动态").font(ZFont.title3)
                        Spacer()
                        Text("跨任务汇总 · 最新在上").font(ZFont.caption2).foregroundStyle(ZColor.muted)
                    }.padding(18)
                    ForEach(projection.visiblePosts) { post in
                        if let sessionID = post.sessionId {
                            Button { model.openTask(sessionId: sessionID) } label: {
                                agentActivityRow(post)
                            }
                            .buttonStyle(.plain)
                            .accessibilityHint("查看任务")
                        } else {
                            agentActivityRow(post)
                        }
                    }
                    if !showAllActivity && projection.remainingPostCount > 0 {
                        Button("查看其余 \(projection.remainingPostCount) 条历史动态") { showAllActivity = true }
                            .font(ZFont.caption2).foregroundStyle(ZColor.sageText)
                            .frame(maxWidth: .infinity, minHeight: 44).padding(.vertical, 4)
                    }
                    if projection.posts.isEmpty {
                        VStack(spacing: 7) {
                            Text("还没有 Agent 动态").font(ZFont.callout.weight(.black))
                            Text("布置第一个任务后，重要进展会汇总在这里。")
                                .font(ZFont.footnote).foregroundStyle(ZColor.muted)
                        }
                        .frame(maxWidth: .infinity).padding(.vertical, 38)
                    }
                }
            }.scrollIndicators(.hidden)
        }
        .zPageSurface()
        .sheet(isPresented: $editing) {
            AgentEditorView(model: model, project: project)
                .environment(\.colorScheme, .dark)
                .presentationDetents([.large])
                .presentationBackground(ZColor.paper)
        }
    }

    private func metric(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value).font(ZFont.subheadline.weight(.black))
            Text(label).font(ZFont.caption2).foregroundStyle(ZColor.muted)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private func agentActivityRow(_ post: FeedPost) -> some View {
        HStack(alignment: .top, spacing: 10) {
            AgentAvatar(value: project.agentProfile.avatar, size: 28)
            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Text(project.agentProfile.displayName).font(ZFont.subheadline.weight(.black))
                    TimelineView(.periodic(from: .now, by: 30)) { _ in
                        Text("· \(relative(post.createdAt))")
                    }
                    .font(ZFont.caption2).foregroundStyle(ZColor.muted)
                }
                Text(post.headline).font(ZFont.headline)
                Text(post.takeaway).font(ZFont.subheadline).lineLimit(4)
            }
            Spacer()
        }
        .foregroundStyle(ZColor.ink).padding(16)
        .contentShape(Rectangle())
        .overlay(alignment: .bottom) { Rectangle().fill(ZColor.line).frame(height: 1) }
    }

    private func workspaceSection(_ workspacePaths: [String]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("WORKSPACE").font(ZFont.caption2).foregroundStyle(ZColor.muted)
                    Text("工作目录").font(ZFont.headline)
                }
                Spacer()
                Text("新任务默认使用主目录").font(ZFont.caption2).foregroundStyle(ZColor.muted)
            }
            ForEach(Array(workspacePaths.enumerated()), id: \.element) { index, path in
                HStack(alignment: .center, spacing: 10) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(index == 0 ? "主目录" : "其他已识别目录")
                            .font(ZFont.caption2).foregroundStyle(ZColor.muted)
                        Text(path)
                            .font(.caption.monospaced())
                            .foregroundStyle(ZColor.ink)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                    }
                    Spacer(minLength: 4)
                    Button {
                        UIPasteboard.general.string = path
                        copiedWorkspacePath = path
                    } label: {
                        Text(copiedWorkspacePath == path ? "已复制" : "复制")
                            .font(ZFont.caption2)
                            .padding(.horizontal, 9).padding(.vertical, 7)
                            .background(ZColor.control)
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
                }
                .padding(11)
                .background(ZColor.control)
                .clipShape(RoundedRectangle(cornerRadius: ZRadius.small, style: .continuous))
            }
        }
        .padding(14)
        .background(ZColor.raised)
        .overlay(RoundedRectangle(cornerRadius: ZRadius.inner, style: .continuous).stroke(ZColor.line))
        .clipShape(RoundedRectangle(cornerRadius: ZRadius.inner, style: .continuous))
        .padding(.horizontal, 18).padding(.bottom, 14)
    }

    private func trustSection(policy: ProjectTrustPolicy?, audit: [TrustAuditEntry]) -> some View {
        let enabled = policy?.preset == "safe_automation"
        return VStack(alignment: .leading, spacing: 10) {
            Toggle(isOn: Binding(
                get: { enabled },
                set: { model.updateTrustPolicy(projectId: project.id, preset: $0 ? "safe_automation" : "ask") }
            )) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("自动化权限").font(ZFont.subheadline.weight(.black))
                    Text(enabled ? "项目内读取、搜索、测试和构建可自动继续" : "所有授权动作都会询问")
                        .font(ZFont.caption2).foregroundStyle(ZColor.muted)
                }
            }
            ForEach(audit) { entry in
                Text("\(entry.decision == "auto_allowed" ? "自动允许" : "已询问") · \(entry.category) · \(entry.actionSummary)")
                    .font(ZFont.caption2).foregroundStyle(ZColor.muted).lineLimit(2)
            }
        }
        .padding(14)
        .background(ZColor.raised)
        .overlay(RoundedRectangle(cornerRadius: ZRadius.inner, style: .continuous).stroke(ZColor.line))
        .clipShape(RoundedRectangle(cornerRadius: ZRadius.inner, style: .continuous))
        .padding(.horizontal, 18).padding(.bottom, 14)
    }
}

private struct AgentEditorView: View {
    @ObservedObject var model: AppModel
    let project: Project
    @Environment(\.dismiss) private var dismiss
    @State private var displayName: String
    @State private var avatar: String
    @State private var bio: String
    @State private var provider: String

    init(model: AppModel, project: Project) {
        self.model = model
        self.project = project
        _displayName = State(initialValue: project.agentProfile.displayName)
        _avatar = State(initialValue: project.agentProfile.avatar)
        _bio = State(initialValue: project.agentProfile.bio)
        _provider = State(initialValue: project.agentProfile.defaultProvider?.rawValue ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("头像") {
                    HStack {
                        Spacer()
                        AgentAvatar(value: avatar, size: 72)
                        Spacer()
                    }
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 6), spacing: 10) {
                        ForEach(1...24, id: \.self) { number in
                            let id = String(format: "user-%02d", number)
                            Button { avatar = id } label: {
                                UserAvatar(id: id, size: 42)
                                    .overlay(Circle().stroke(id == avatar ? ZColor.coral : Color.clear, lineWidth: 3))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                Section("身份") {
                    TextField("Agent 名称", text: $displayName)
                    TextField("一句话简介", text: $bio, axis: .vertical).lineLimit(3...6)
                }
                Section("默认 Runtime") {
                    Picker("Runtime", selection: $provider) {
                        Text("自动选择").tag("")
                        HStack { ProviderIcon(provider: .codex); Text("Codex") }.tag("codex")
                        HStack { ProviderIcon(provider: .claude); Text("Claude Code") }.tag("claude")
                    }
                }
            }
            .scrollContentBackground(.hidden).background(ZColor.paper).foregroundStyle(ZColor.ink)
            .navigationTitle("编辑 Agent Profile")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        model.updateAgent(
                            project: project,
                            displayName: displayName.trimmingCharacters(in: .whitespacesAndNewlines),
                            avatar: avatar.trimmingCharacters(in: .whitespacesAndNewlines),
                            bio: bio.trimmingCharacters(in: .whitespacesAndNewlines),
                            provider: Provider(rawValue: provider)
                        )
                        dismiss()
                    }
                    .disabled(displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || avatar.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}

private enum SettingsSheet: String, Identifiable {
    case avatars
    var id: String { rawValue }
}

struct ConnectionRecoveryView: View {
    @ObservedObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var isRePairing = false
    @State private var isRetrying = false

    var body: some View {
        Group {
            if isRePairing {
                PairingView(
                    model: model,
                    onCancel: { isRePairing = false },
                    onPaired: { dismiss() },
                    showsExistingError: false
                )
            } else {
                recoveryGuide
            }
        }
        .onChange(of: model.bridge.connected) { _, connected in
            if connected { dismiss() }
        }
    }

    private var recoveryGuide: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("当前未连接", systemImage: "wifi.exclamationmark")
                            .font(ZFont.title3)
                            .foregroundStyle(ZColor.coralText)
                        Text("先尝试使用现有配对重连；如果 Mac 重装过、设备已撤销或仍然失败，请生成新的连接码重新配对。")
                            .font(ZFont.subheadline)
                            .foregroundStyle(ZColor.muted)
                            .lineSpacing(3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(ZColor.raised)
                    .overlay(RoundedRectangle(cornerRadius: ZRadius.inner).stroke(ZColor.line))
                    .clipShape(RoundedRectangle(cornerRadius: ZRadius.inner, style: .continuous))

                    VStack(alignment: .leading, spacing: 0) {
                        recoveryStep(
                            number: "1",
                            title: "打开 Mac 上的 Zimlo",
                            detail: "确认 Dock 或菜单栏中的 Zimlo 正在运行。"
                        )
                        Divider().overlay(ZColor.line).padding(.leading, 52)
                        recoveryStep(
                            number: "2",
                            title: "进入“连接手机”",
                            detail: "刷新二维码；真机可复制通用码，模拟器或同一 Wi-Fi 请复制本地码。"
                        )
                        Divider().overlay(ZColor.line).padding(.leading, 52)
                        recoveryStep(
                            number: "3",
                            title: "重新连接",
                            detail: "真机可扫码；模拟器请选择粘贴连接码。使用本地连接时，两台设备需在同一 Wi-Fi。"
                        )
                    }
                    .background(ZColor.raised)
                    .overlay(RoundedRectangle(cornerRadius: ZRadius.inner).stroke(ZColor.line))
                    .clipShape(RoundedRectangle(cornerRadius: ZRadius.inner, style: .continuous))
                }
                .padding(16)
                .padding(.bottom, dynamicTypeSize.isAccessibilitySize ? 190 : 132)
            }
            .scrollIndicators(.hidden)
            .background(ZColor.paper)
            .navigationTitle("重新连接 Mac")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 9) {
                    Button(action: retryExistingPairing) {
                        HStack(spacing: 8) {
                            if isRetrying { ProgressView().tint(ZColor.onAccent) }
                            Text(isRetrying ? "正在重试" : "立即重试")
                        }
                        .font(ZFont.callout.weight(.black))
                        .frame(maxWidth: .infinity, minHeight: 50)
                        .foregroundStyle(ZColor.onAccent)
                        .background(ZColor.acid)
                        .clipShape(RoundedRectangle(cornerRadius: ZRadius.control, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(isRetrying)

                    Button {
                        isRetrying = false
                        isRePairing = true
                    } label: {
                        Label("使用新连接码", systemImage: "qrcode")
                            .font(ZFont.callout.weight(.bold))
                            .frame(maxWidth: .infinity, minHeight: 48)
                            .foregroundStyle(ZColor.ink)
                            .background(ZColor.control)
                            .overlay(RoundedRectangle(cornerRadius: ZRadius.control).stroke(ZColor.line))
                            .clipShape(RoundedRectangle(cornerRadius: ZRadius.control, style: .continuous))
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 10)
                .background(.ultraThinMaterial)
            }
        }
    }

    private func recoveryStep(number: String, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(number)
                .font(ZFont.caption.weight(.black))
                .foregroundStyle(ZColor.onAccent)
                .frame(width: 30, height: 30)
                .background(ZColor.acid)
                .clipShape(Circle())
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(ZFont.subheadline.weight(.bold))
                Text(detail)
                    .font(ZFont.footnote)
                    .foregroundStyle(ZColor.muted)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .foregroundStyle(ZColor.ink)
        .padding(14)
    }

    private func retryExistingPairing() {
        guard !isRetrying else { return }
        isRetrying = true
        model.bridge.retryNow()
        Task {
            try? await Task.sleep(for: .seconds(4))
            guard !Task.isCancelled, !model.bridge.connected else { return }
            isRetrying = false
        }
    }
}

struct SettingsView: View {
    @ObservedObject var model: AppModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var presentedSheet: SettingsSheet?
    @State private var showingForgetConfirmation = false

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 15) {
                profileSummary
                if model.snapshot.features.pushNotifications { notificationsSection }
                connectionSection
                runtimeSection
                forgetButton
            }
            .padding(.horizontal, 14)
            .padding(.top, 14)
            .padding(.bottom, 26)
        }
        .scrollIndicators(.hidden)
        .zPageSurface()
        .sheet(item: $presentedSheet) { destination in
            switch destination {
            case .avatars:
                AvatarPickerSheet(model: model)
                    .environment(\.colorScheme, .dark)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
                    .presentationBackground(ZColor.paper)
            }
        }
    }

    private var profileSummary: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                HStack(spacing: 14) {
                    avatarButton(size: 54)
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Zimlo")
                            .font(ZFont.headline)
                            .lineLimit(1)
                            .minimumScaleFactor(0.72)
                        HStack(alignment: .firstTextBaseline, spacing: 7) {
                            Circle().fill(model.bridge.connected ? ZColor.sage : ZColor.coralText).frame(width: 7, height: 7)
                            Text(accessibleConnectionLabel)
                                .font(ZFont.caption2)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .foregroundStyle(ZColor.muted)
                    }
                    Spacer(minLength: 0)
                }
            } else {
                HStack(spacing: 14) {
                    avatarButton(size: 62)
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Zimlo").font(ZFont.title3)
                        HStack(spacing: 7) {
                            Circle().fill(model.bridge.connected ? ZColor.sage : ZColor.coralText).frame(width: 7, height: 7)
                            Text(model.bridge.connected ? "已连接 Mac" : "未连接")
                        }
                        .font(ZFont.caption2)
                        .foregroundStyle(ZColor.muted)
                    }
                    Spacer(minLength: 8)
                    if let mode = connectionModeLabel {
                        Text(mode)
                            .font(ZFont.caption2)
                            .foregroundStyle(ZColor.sageText)
                            .padding(.horizontal, 10).padding(.vertical, 7)
                            .background(ZColor.control)
                            .clipShape(Capsule())
                    }
                }
            }
        }
        .padding(15)
        .background(ZColor.raised)
        .overlay(RoundedRectangle(cornerRadius: ZRadius.inner, style: .continuous).stroke(ZColor.line))
        .clipShape(RoundedRectangle(cornerRadius: ZRadius.inner, style: .continuous))
    }

    private func avatarButton(size: CGFloat) -> some View {
        Button { presentedSheet = .avatars } label: {
            UserAvatar(id: model.snapshot.userProfile.avatarId, size: size)
                .overlay(alignment: .bottomTrailing) {
                    Image(systemName: "pencil")
                        .font(.system(size: 10, weight: .black))
                        .foregroundStyle(ZColor.ink)
                        .frame(width: 23, height: 23)
                        .background(ZColor.control)
                        .overlay(Circle().stroke(ZColor.paper, lineWidth: 3))
                        .clipShape(Circle())
                }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("更换头像")
    }

    private var notificationsSection: some View {
        settingsSection("通知") {
            Toggle(isOn: notificationsEnabled) {
                settingsLabel("通知", systemImage: "bell.fill")
            }
            .tint(ZColor.acid)
            .padding(.vertical, 3)

            if model.notificationPermission == "系统已拒绝" {
                Divider().overlay(ZColor.line)
                Button {
                    guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                    UIApplication.shared.open(url)
                } label: {
                    settingsValueRow("系统权限", value: "打开设置", systemImage: "gearshape.fill", emphasized: true)
                }
                .buttonStyle(.plain)
            }

            if model.snapshot.notificationSettings.enabled {
                Divider().overlay(ZColor.line)
                notificationToggle("审批与回复", keyPath: \.approvals)
                Divider().overlay(ZColor.line)
                notificationToggle("任务失败", keyPath: \.failures)
                Divider().overlay(ZColor.line)
                notificationToggle("待审结果", keyPath: \.reviews)
                Divider().overlay(ZColor.line)
                notificationToggle("锁屏任务标题", keyPath: \.showTaskTitle)
            }
        }
    }

    private var connectionSection: some View {
        settingsSection("这台手机") {
            if model.bridge.connected {
                settingsValueRow("连接", value: "已连接", systemImage: "link")
            } else {
                Button { model.showingConnectionRecovery = true } label: {
                    HStack(spacing: 11) {
                        settingsLabel("连接", systemImage: "link")
                        Spacer()
                        Text("重新连接").foregroundStyle(ZColor.sageText)
                        Image(systemName: "chevron.right")
                            .font(ZFont.caption2)
                            .foregroundStyle(ZColor.muted)
                    }
                    .font(ZFont.subheadline)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint("查看重连步骤或使用新的连接码")
            }
            Divider().overlay(ZColor.line)
            Button { model.showingOutbox = true } label: {
                HStack(spacing: 11) {
                    settingsLabel("待同步", systemImage: "arrow.triangle.2.circlepath")
                    Spacer()
                    Text(model.pendingOutboxCount == 0 ? "已完成" : "\(model.pendingOutboxCount) 条")
                        .foregroundStyle(model.pendingOutboxCount == 0 ? ZColor.muted : ZColor.sageText)
                    Image(systemName: "chevron.right").font(ZFont.caption2).foregroundStyle(ZColor.muted)
                }
                .font(ZFont.subheadline)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Divider().overlay(ZColor.line)
            settingsValueRow(
                "自动化",
                value: model.snapshot.lanApprovalsEnabled ? "已授权" : "只读",
                systemImage: "checkmark.shield.fill"
            )
        }
    }

    private var runtimeSection: some View {
        settingsSection("Runtime") {
            if availableProviders.isEmpty {
                settingsValueRow("可用 Runtime", value: "等待同步", systemImage: "terminal")
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 9) { runtimeChips }
                    VStack(alignment: .leading, spacing: 9) { runtimeChips }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 3)
            }
        }
    }

    @ViewBuilder
    private var runtimeChips: some View {
        ForEach(availableProviders) { provider in
            HStack(spacing: 8) {
                ProviderIcon(provider: provider, size: 18)
                Text(provider.label).font(ZFont.subheadline.weight(.semibold))
            }
            .foregroundStyle(ZColor.ink)
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .background(ZColor.control)
            .overlay(Capsule().stroke(ZColor.line))
            .clipShape(Capsule())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("可用 Runtime：\(provider.label)")
        }
    }

    private var forgetButton: some View {
        Button(model.isForgettingDevice ? "正在解除…" : "解除配对", role: .destructive) {
            showingForgetConfirmation = true
        }
        .font(ZFont.subheadline.weight(.bold))
        .foregroundStyle(ZColor.coralText)
        .frame(maxWidth: .infinity, minHeight: 48)
        .background(ZColor.coral.opacity(0.10))
        .overlay(RoundedRectangle(cornerRadius: ZRadius.control).stroke(ZColor.coral.opacity(0.72)))
        .clipShape(RoundedRectangle(cornerRadius: ZRadius.control, style: .continuous))
        .disabled(model.isForgettingDevice)
        .confirmationDialog("解除配对？", isPresented: $showingForgetConfirmation, titleVisibility: .visible) {
            Button("解除并清除本机数据", role: .destructive) { model.forgetDevice() }
            Button("取消", role: .cancel) {}
        } message: {
            Text("需要保持 Mac 在线。Zimlo 会先撤销通知注册，再清除本机数据。")
        }
    }

    private var notificationsEnabled: Binding<Bool> {
        Binding(
            get: { model.snapshot.notificationSettings.enabled },
            set: { enabled in
                if enabled { model.requestNotifications() }
                else {
                    var settings = model.snapshot.notificationSettings
                    settings.enabled = false
                    model.updateNotificationSettings(settings)
                }
            }
        )
    }

    private var availableProviders: [Provider] {
        let reported = model.snapshot.workspaces.flatMap(\.providers)
            + model.snapshot.projects.flatMap(\.providers)
            + model.snapshot.sessions.map(\.provider)
        return Provider.allCases.filter(reported.contains)
    }

    private var connectionModeLabel: String? {
        guard model.bridge.connected else { return nil }
        switch model.bridge.connectionMode {
        case "cloud": return "云端"
        case "local": return "本地"
        default: return nil
        }
    }

    private var accessibleConnectionLabel: String {
        guard model.bridge.connected else { return "未连接" }
        return connectionModeLabel.map { "已连接 Mac · \($0)" } ?? "已连接 Mac"
    }

    private func settingsSection<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(ZFont.caption2).foregroundStyle(ZColor.muted).padding(.leading, 3)
            VStack(alignment: .leading, spacing: 0) { content() }
                .padding(.horizontal, 14).padding(.vertical, 8)
                .foregroundStyle(ZColor.ink)
                .background(ZColor.raised)
                .overlay(RoundedRectangle(cornerRadius: ZRadius.inner, style: .continuous).stroke(ZColor.line))
                .clipShape(RoundedRectangle(cornerRadius: ZRadius.inner, style: .continuous))
        }
    }

    private func settingsLabel(_ title: String, systemImage: String) -> some View {
        Label {
            Text(title).font(ZFont.subheadline.weight(.semibold))
        } icon: {
            Image(systemName: systemImage).foregroundStyle(ZColor.sageText).frame(width: 20)
        }
    }

    private func settingsValueRow(_ title: String, value: String, systemImage: String, emphasized: Bool = false) -> some View {
        HStack(spacing: 11) {
            settingsLabel(title, systemImage: systemImage)
            Spacer()
            Text(value).foregroundStyle(emphasized ? ZColor.sageText : ZColor.muted)
        }
        .font(ZFont.subheadline)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }

    private func notificationToggle(_ title: String, keyPath: WritableKeyPath<NotificationSettings, Bool>) -> some View {
        Toggle(title, isOn: Binding(
            get: { model.snapshot.notificationSettings[keyPath: keyPath] },
            set: { value in
                var settings = model.snapshot.notificationSettings
                settings[keyPath: keyPath] = value
                model.updateNotificationSettings(settings)
            }
        ))
        .font(ZFont.subheadline.weight(.semibold))
        .tint(ZColor.acid)
        .frame(minHeight: 44)
    }
}

private struct AvatarPickerSheet: View {
    @ObservedObject var model: AppModel
    @Environment(\.dismiss) private var dismiss

    private let columns = [GridItem(.adaptive(minimum: 62, maximum: 78), spacing: 14)]

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVGrid(columns: columns, spacing: 16) {
                    ForEach(1...24, id: \.self) { number in
                        let id = String(format: "user-%02d", number)
                        let selected = id == model.snapshot.userProfile.avatarId
                        Button {
                            guard !selected else { dismiss(); return }
                            model.updateAvatar(id)
                            Haptics.selection()
                            dismiss()
                        } label: {
                            UserAvatar(id: id, size: 62)
                                .padding(4)
                                .overlay(Circle().stroke(selected ? ZColor.acid : Color.clear, lineWidth: 3))
                                .overlay(alignment: .bottomTrailing) {
                                    if selected {
                                        Image(systemName: "checkmark")
                                            .font(.system(size: 10, weight: .black))
                                            .foregroundStyle(ZColor.onAccent)
                                            .frame(width: 22, height: 22)
                                            .background(ZColor.acid)
                                            .clipShape(Circle())
                                    }
                                }
                        }
                        .buttonStyle(.plain)
                        .frame(minWidth: 68, minHeight: 68)
                        .accessibilityLabel("头像 \(number)")
                        .accessibilityAddTraits(selected ? .isSelected : [])
                    }
                }
                .padding(18)
            }
            .scrollIndicators(.hidden)
            .background(ZColor.paper)
            .navigationTitle("头像")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("关闭")
                }
            }
        }
    }
}
