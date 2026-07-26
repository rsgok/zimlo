import SwiftUI

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

private struct TaskDirectorySection: Identifiable {
    let id: String
    let hint: String
    let sessions: [AgentSession]
}

struct TasksDirectoryView: View {
    @ObservedObject var model: AppModel
    @State private var search = ""
    @State private var filter = "全部"
    @State private var showingSearch = false
    private let filters = ["全部", "待我处理", "进行中", "可继续"]

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Picker("筛选", selection: $filter) {
                        ForEach(filters, id: \.self) { Text($0).tag($0) }
                    }.pickerStyle(.segmented)
                    Button { withAnimation(.easeInOut(duration: 0.18)) { showingSearch.toggle() } } label: {
                        Image(systemName: showingSearch ? "xmark" : "magnifyingglass")
                            .frame(width: 34, height: 34)
                    }
                }
                if showingSearch {
                    TextField("搜索任务或项目", text: $search)
                        .textFieldStyle(.roundedBorder)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 10)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    ForEach(taskSections) { section in
                        VStack(alignment: .leading, spacing: 0) {
                            HStack {
                                Text(section.id).font(.system(size: 14, weight: .black))
                                Spacer()
                                Text("\(section.sessions.count) · \(section.hint)").font(.system(size: 9, weight: .bold)).foregroundStyle(ZColor.muted)
                            }.padding(14)
                            ForEach(section.sessions) { session in
                                let state = effectiveState(session)
                                HStack(spacing: 8) {
                                    Button { model.openTask(sessionId: session.id) } label: {
                                        HStack(spacing: 12) {
                                            ProviderBadge(provider: session.provider, iconOnly: true)
                                            VStack(alignment: .leading, spacing: 4) {
                                                Text(taskTitle(session)).font(.system(size: 14, weight: .bold)).lineLimit(2)
                                                HStack(spacing: 6) {
                                                    Text(projectName(session))
                                                        .font(.system(size: 10, weight: .medium)).foregroundStyle(ZColor.muted).lineLimit(1)
                                                    Text("· \(relative(session.lastActivityAt))")
                                                        .font(.system(size: 10, weight: .medium)).foregroundStyle(ZColor.muted)
                                                }
                                                if let nextStep = nextStep(state) {
                                                    Text(nextStep).font(.system(size: 9, weight: .bold))
                                                        .foregroundStyle(statePriority(state) == 0 ? ZColor.coral : ZColor.sage)
                                                        .lineLimit(1)
                                                }
                                            }
                                            Spacer(minLength: 8)
                                            VStack(alignment: .trailing, spacing: 6) {
                                                Text(stateLabel(state)).font(.system(size: 9, weight: .black))
                                                    .foregroundStyle(statusColor(state))
                                                    .padding(.horizontal, 7).padding(.vertical, 5)
                                                    .background(statusColor(state).opacity(0.11))
                                                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                                            }
                                        }
                                        .foregroundStyle(ZColor.ink).padding(.leading, 14).padding(.vertical, 12)
                                    }
                                    Menu {
                                        let preference = model.snapshot.taskPreferences.first { $0.sessionId == session.id }
                                        Button(preference?.pinnedAt == nil ? "置顶任务" : "取消置顶") {
                                            model.setPinned(sessionId: session.id, pinned: preference?.pinnedAt == nil)
                                        }
                                        Button("归档任务") { model.setArchived(sessionId: session.id, archived: true) }
                                    } label: {
                                        Image(systemName: "ellipsis").font(.caption.bold()).foregroundStyle(ZColor.muted)
                                            .frame(width: 38, height: 38)
                                    }
                                }
                                .overlay(alignment: .top) { Rectangle().fill(ZColor.line).frame(height: 1) }
                            }
                        }
                    }
                }.padding(12)
            }.scrollIndicators(.hidden)
        }
        .foregroundStyle(ZColor.ink).background(ZColor.paper)
        .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
        .padding(.horizontal, 8).padding(.bottom, 5)
    }

    private var managedSessions: [AgentSession] {
        let archived = Set(model.snapshot.taskPreferences.compactMap { $0.archivedAt == nil ? nil : $0.sessionId })
        return collapsedDirectorySessions(model.snapshot.sessions).filter { !archived.contains($0.id) }
    }

    private var attentionCount: Int { managedSessions.filter { statePriority(effectiveState($0)) == 0 }.count }
    private var activeCount: Int { managedSessions.filter { statePriority(effectiveState($0)) == 1 }.count }
    private var readyCount: Int { managedSessions.filter { isReady($0, effectiveState($0)) }.count }

    private var visibleSessions: [AgentSession] {
        managedSessions.filter { session in
            let matchesSearch = search.isEmpty
                || taskTitle(session).localizedCaseInsensitiveContains(search)
                || projectName(session).localizedCaseInsensitiveContains(search)
                || session.cwd?.localizedCaseInsensitiveContains(search) == true
            guard matchesSearch else { return false }
            let state = effectiveState(session)
            switch filter {
            case "待我处理": return statePriority(state) == 0
            case "进行中": return statePriority(state) == 1
            case "可继续": return isReady(session, state)
            default: return true
            }
        }
        .sorted { left, right in
            let leftPinned = model.snapshot.taskPreferences.first { $0.sessionId == left.id }?.pinnedAt != nil
            let rightPinned = model.snapshot.taskPreferences.first { $0.sessionId == right.id }?.pinnedAt != nil
            if leftPinned != rightPinned { return leftPinned }
            let priority = statePriority(effectiveState(left)) - statePriority(effectiveState(right))
            if priority != 0 { return priority < 0 }
            return left.lastActivityAt == right.lastActivityAt ? left.id < right.id : left.lastActivityAt > right.lastActivityAt
        }
    }

    private var taskSections: [TaskDirectorySection] {
        let definitions = [
            ("待你处理", "回复、审阅或恢复", 0),
            ("正在工作", "Agent 正在推进", 1),
            ("可继续与最近完成", "随时回看或继续", 2),
        ]
        return definitions.compactMap { title, hint, priority in
            let sessions = visibleSessions.filter {
                priority == 2 ? statePriority(effectiveState($0)) >= 2 : statePriority(effectiveState($0)) == priority
            }
            return sessions.isEmpty ? nil : TaskDirectorySection(id: title, hint: hint, sessions: sessions)
        }
    }

    private func effectiveState(_ session: AgentSession) -> String {
        guard !session.correlationUncertain else { return session.status }
        return model.snapshot.tasks
            .filter { $0.sessionId == session.id }
            .max { $0.updatedAt < $1.updatedAt }?.state ?? session.status
    }

    private func statePriority(_ state: String) -> Int {
        if ["waiting", "waiting_input", "user_review", "failed"].contains(state) { return 0 }
        if ["running", "reviewing"].contains(state) { return 1 }
        return 2
    }

    private func isReady(_ session: AgentSession, _ state: String) -> Bool {
        statePriority(state) >= 2 && (session.capabilities.resumable || session.capabilities.replyable || state == "idle")
    }

    private func taskTitle(_ session: AgentSession) -> String {
        let generated = session.title.hasPrefix("Codex ·") || session.title.hasPrefix("Claude ·")
        guard generated, !session.correlationUncertain,
              let reason = model.snapshot.tasks.filter({ $0.sessionId == session.id }).max(by: { $0.updatedAt < $1.updatedAt })?.reason,
              !reason.isEmpty, reason.count <= 100 else { return session.title }
        return reason.trimmingCharacters(in: CharacterSet(charactersIn: "。"))
    }

    private func projectName(_ session: AgentSession) -> String {
        session.projectName
            ?? session.projectId.flatMap { id in model.snapshot.projects.first { $0.id == id }?.name }
            ?? session.cwd?.split(separator: "/").last.map(String.init)
            ?? "未归属"
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
        if ["failed", "waiting", "waiting_input", "user_review"].contains(state) { return ZColor.coral }
        if ["running", "reviewing"].contains(state) { return ZColor.sage }
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
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Picker("筛选", selection: $filter) {
                        ForEach(filters, id: \.self) { Text($0).tag($0) }
                    }.pickerStyle(.segmented)
                    Button { withAnimation(.easeInOut(duration: 0.18)) { showingSearch.toggle() } } label: {
                        Image(systemName: showingSearch ? "xmark" : "magnifyingglass")
                            .frame(width: 34, height: 34)
                    }
                }
                if showingSearch {
                    TextField("搜索 Agent 或项目", text: $search).textFieldStyle(.roundedBorder)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            ScrollView {
                LazyVStack(spacing: 12) {
                    ForEach(agents) { project in
                        HStack(spacing: 0) {
                            Button { model.openAgent(projectId: project.id) } label: {
                                HStack(alignment: .top, spacing: 13) {
                                    ZStack(alignment: .bottomTrailing) {
                                        AgentAvatar(value: project.agentProfile.avatar, size: 52)
                                        Circle().fill(activeCount(project) > 0 ? ZColor.sage : ZColor.muted)
                                            .frame(width: 11, height: 11).overlay(Circle().stroke(ZColor.paper, lineWidth: 3))
                                    }
                                    VStack(alignment: .leading, spacing: 6) {
                                        HStack {
                                            Text(project.agentProfile.displayName).font(.system(size: 16, weight: .black)).lineLimit(1)
                                            Spacer()
                                            Text(activeCount(project) > 0 ? "\(activeCount(project)) 个进行中" : project.sessionCount > 0 ? "随时可用" : "尚未启用")
                                                .font(.system(size: 8, weight: .black)).foregroundStyle(activeCount(project) > 0 ? ZColor.sage : ZColor.muted)
                                        }
                                        if let bio = agentBio(project) {
                                            Text(bio).font(.system(size: 11, weight: .medium))
                                                .foregroundStyle(ZColor.ink.opacity(0.72)).lineLimit(2)
                                        }
                                        HStack(spacing: 5) {
                                            Text(project.name)
                                            Text("· \(project.sessionCount) 个任务")
                                            Text("· \(relative(project.lastUsedAt))")
                                        }
                                        .font(.system(size: 9, weight: .bold)).foregroundStyle(ZColor.muted).lineLimit(1)
                                        if let provider = project.agentProfile.defaultProvider {
                                            HStack(spacing: 5) {
                                                ProviderBadge(provider: provider, iconOnly: true)
                                                Text("默认 Runtime")
                                            }.font(.system(size: 8, weight: .bold)).foregroundStyle(ZColor.muted)
                                        } else if !project.providers.isEmpty {
                                            HStack(spacing: 5) {
                                                ForEach(project.providers, id: \.rawValue) { provider in
                                                    ProviderBadge(provider: provider, iconOnly: true)
                                                }
                                                Text("可用 Runtime")
                                            }.font(.system(size: 8, weight: .bold)).foregroundStyle(ZColor.muted)
                                        } else {
                                            Text("Runtime 自动选择").font(.system(size: 8, weight: .bold)).foregroundStyle(ZColor.muted)
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
                                    Image(systemName: "plus").font(.system(size: 15, weight: .black))
                                    Text("新任务").font(.system(size: 8, weight: .black))
                                }
                                .foregroundStyle(ZColor.sage).frame(width: 62).frame(maxHeight: .infinity)
                                .background(ZColor.acid.opacity(0.14))
                            }
                        }
                        .background(Color.white.opacity(0.5))
                        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                    }
                }.padding(12)
            }.scrollIndicators(.hidden)
        }
        .background(ZColor.paper)
        .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
        .padding(.horizontal, 8).padding(.bottom, 5)
    }

    private var managedSessions: [AgentSession] { collapsedDirectorySessions(model.snapshot.sessions) }
    private var usedCount: Int { model.snapshot.projects.filter { $0.sessionCount > 0 }.count }
    private var workingCount: Int { model.snapshot.projects.filter { activeCount($0) > 0 }.count }
    private var runningTaskCount: Int { model.snapshot.projects.reduce(0) { $0 + activeCount($1) } }

    private func activeCount(_ project: Project) -> Int {
        managedSessions.filter { $0.projectId == project.id && $0.status == "running" }.count
    }

    private func agentBio(_ project: Project) -> String? {
        let value = project.agentProfile.bio.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty || value == "负责 \(project.name) 项目的长期工作与上下文。" { return nil }
        return value
    }

    private var agents: [Project] {
        model.snapshot.projects
            .filter { project in
                if filter == "已启用" && project.sessionCount == 0 { return false }
                if filter == "工作中" && activeCount(project) == 0 { return false }
                return search.isEmpty || project.agentProfile.displayName.localizedCaseInsensitiveContains(search) || project.name.localizedCaseInsensitiveContains(search)
            }
            .sorted { left, right in
                let activeDifference = activeCount(left) - activeCount(right)
                if activeDifference != 0 { return activeDifference > 0 }
                if left.lastUsedAt != right.lastUsedAt { return left.lastUsedAt > right.lastUsedAt }
                return left.agentProfile.displayName.localizedStandardCompare(right.agentProfile.displayName) == .orderedAscending
            }
    }
}

struct AgentDetailView: View {
    @ObservedObject var model: AppModel
    let project: Project
    @State private var editing = false
    @State private var showAllActivity = false

    private var sessions: [AgentSession] { model.snapshot.sessions.filter { $0.projectId == project.id } }
    private var managedSessions: [AgentSession] { collapsedDirectorySessions(sessions) }
    private var posts: [FeedPost] { model.snapshot.posts.filter { $0.projectId == project.id }.sorted { $0.createdAt > $1.createdAt } }
    private var visiblePosts: [FeedPost] { showAllActivity ? posts : Array(posts.prefix(8)) }
    private var running: Int { managedSessions.filter { $0.status == "running" }.count }
    private var visibleBio: String? {
        let value = project.agentProfile.bio.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty || value == "负责 \(project.name) 项目的长期工作与上下文。" { return nil }
        return value
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(alignment: .top, spacing: 14) {
                        AgentAvatar(value: project.agentProfile.avatar, size: 70)
                        VStack(alignment: .leading, spacing: 5) {
                            Text(project.agentProfile.displayName).font(.system(size: 25, weight: .black))
                            Text(project.name).font(.system(size: 11, weight: .semibold)).foregroundStyle(ZColor.muted)
                            Text(visibleBio ?? "还没有设置专长与工作方式。编辑资料后，更容易理解这个 Agent 适合做什么。")
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(visibleBio == nil ? ZColor.muted : ZColor.ink).lineLimit(3)
                        }
                    }.padding(18)
                    HStack {
                        Button { model.newTaskProjectId = project.id; model.showingNewTask = true } label: {
                            Label("新任务", systemImage: "plus")
                        }.buttonStyle(ActionButtonStyle(primary: true))
                        Button { editing = true } label: {
                            Label("编辑资料", systemImage: "pencil")
                        }.buttonStyle(ActionButtonStyle(primary: false))
                    }
                    .padding(.horizontal, 18).padding(.bottom, 12)
                    HStack {
                        metric(running > 0 ? "\(running)" : "空闲", "正在工作")
                        metric("\(project.sessionCount)", "历史任务")
                        metric(project.agentProfile.defaultProvider?.label ?? "自动", "默认 Runtime")
                    }
                    .padding(.horizontal, 18).padding(.bottom, 14)
                    if model.snapshot.features.projectTrustPolicy { trustSection }
                    Rectangle().fill(ZColor.line).frame(height: 1)
                    HStack {
                        Text("重要动态").font(.system(size: 20, weight: .black))
                        Spacer()
                        Text("跨任务汇总 · 最新在上").font(.system(size: 9, weight: .bold)).foregroundStyle(ZColor.muted)
                    }.padding(18)
                    ForEach(visiblePosts) { post in
                        Button {
                            if let sessionId = post.sessionId { model.openTask(sessionId: sessionId) }
                        } label: {
                            HStack(alignment: .top, spacing: 10) {
                                AgentAvatar(value: project.agentProfile.avatar, size: 28)
                                VStack(alignment: .leading, spacing: 5) {
                                    HStack {
                                        Text(project.agentProfile.displayName).font(.system(size: 13, weight: .black))
                                        Text("· \(relative(post.createdAt))").font(.system(size: 10)).foregroundStyle(ZColor.muted)
                                    }
                                    Text(post.headline).font(.system(size: 16, weight: .black))
                                    Text(post.takeaway).font(.system(size: 13, weight: .medium)).lineLimit(4)
                                }
                                Spacer()
                            }
                            .foregroundStyle(ZColor.ink).padding(16)
                            .overlay(alignment: .bottom) { Rectangle().fill(ZColor.line).frame(height: 1) }
                        }
                    }
                    if !showAllActivity && posts.count > visiblePosts.count {
                        Button("查看其余 \(posts.count - visiblePosts.count) 条历史动态") { showAllActivity = true }
                            .font(.system(size: 10, weight: .bold)).foregroundStyle(ZColor.sage)
                            .frame(maxWidth: .infinity).padding(.vertical, 16)
                    }
                    if posts.isEmpty {
                        VStack(spacing: 7) {
                            Text("还没有 Agent 动态").font(.system(size: 15, weight: .black))
                            Text("布置第一个任务后，重要进展会汇总在这里。")
                                .font(.system(size: 11, weight: .medium)).foregroundStyle(ZColor.muted)
                        }
                        .frame(maxWidth: .infinity).padding(.vertical, 38)
                    }
                }
            }.scrollIndicators(.hidden)
        }
        .foregroundStyle(ZColor.ink).background(ZColor.paper)
        .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
        .padding(.horizontal, 8).padding(.bottom, 5)
        .sheet(isPresented: $editing) {
            AgentEditorView(model: model, project: project)
                .presentationDetents([.large])
                .presentationBackground(ZColor.paper)
        }
    }

    private func metric(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value).font(.system(size: 14, weight: .black))
            Text(label).font(.system(size: 9, weight: .medium)).foregroundStyle(ZColor.muted)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private var trustSection: some View {
        let policy = model.snapshot.trustPolicies.first { $0.projectId == project.id }
        let enabled = policy?.preset == "safe_automation"
        return VStack(alignment: .leading, spacing: 10) {
            Toggle(isOn: Binding(
                get: { enabled },
                set: { model.updateTrustPolicy(projectId: project.id, preset: $0 ? "safe_automation" : "ask") }
            )) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("自动化权限").font(.system(size: 14, weight: .black))
                    Text(enabled ? "项目内读取、搜索、测试和构建可自动继续" : "所有授权动作都会询问")
                        .font(.system(size: 10, weight: .medium)).foregroundStyle(ZColor.muted)
                }
            }
            let audit = model.snapshot.trustAudit.filter { $0.projectId == project.id }.prefix(3)
            ForEach(Array(audit)) { entry in
                Text("\(entry.decision == "auto_allowed" ? "自动允许" : "已询问") · \(entry.category) · \(entry.actionSummary)")
                    .font(.system(size: 9, weight: .medium)).foregroundStyle(ZColor.muted).lineLimit(2)
            }
        }
        .padding(14)
        .background(ZColor.acid.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
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

struct SettingsView: View {
    @ObservedObject var model: AppModel
    @State private var showingAvatars = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(spacing: 14) {
                    UserAvatar(id: model.snapshot.userProfile.avatarId, size: 66)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("你的 Zimlo").font(.system(size: 22, weight: .black))
                        Text("头像只可从 24 个预置形象中选择").font(.system(size: 11, weight: .medium)).foregroundStyle(ZColor.muted)
                    }
                }
                Button("选择头像") { showingAvatars.toggle() }.buttonStyle(ActionButtonStyle(primary: true))
                if showingAvatars {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 4), spacing: 12) {
                        ForEach(1...24, id: \.self) { number in
                            let id = String(format: "user-%02d", number)
                            Button { model.updateAvatar(id) } label: {
                                UserAvatar(id: id, size: 54)
                                    .overlay(Circle().stroke(id == model.snapshot.userProfile.avatarId ? ZColor.coral : Color.clear, lineWidth: 3))
                            }
                        }
                    }
                }
                if model.snapshot.features.pushNotifications { section("主动通知") {
                    row("系统权限", model.notificationPermission)
                    Toggle("允许 Zimlo 通知", isOn: Binding(
                        get: { model.snapshot.notificationSettings.enabled },
                        set: { enabled in
                            if enabled { model.requestNotifications() }
                            else {
                                var settings = model.snapshot.notificationSettings
                                settings.enabled = false
                                model.updateNotificationSettings(settings)
                            }
                        }
                    ))
                    notificationToggle("等待批准或回复", keyPath: \.approvals)
                    notificationToggle("任务失败", keyPath: \.failures)
                    notificationToggle("结果等待审阅", keyPath: \.reviews)
                    notificationToggle("锁屏显示任务标题", keyPath: \.showTaskTitle)
                }}
                section("这台手机") {
                    row("连接状态", model.bridge.connected ? "已连接 Mac" : "等待连接 Mac")
                    row("待同步操作", model.pendingOutboxCount == 0 ? "全部已确认" : "\(model.pendingOutboxCount) 条")
                    row("审批权限", model.snapshot.lanApprovalsEnabled ? "已由 Mac 授权" : "仅查看与回复")
                }
                DisclosureGroup("高级诊断") {
                    section("运行边界") {
                        row("可信项目", "\(model.snapshot.workspaces.count)")
                        HStack {
                            ProviderBadge(provider: .codex, iconOnly: true)
                            ProviderBadge(provider: .claude, iconOnly: true)
                            Spacer()
                            Text("GUI 与 CLI 分开识别").foregroundStyle(ZColor.muted)
                        }
                        .font(.system(size: 13)).padding(.vertical, 11)
                        .overlay(alignment: .bottom) { Rectangle().fill(ZColor.line).frame(height: 1) }
                        row("加密连接", "Secure WS · v2")
                    }
                }
                Button("解除当前设备配对", role: .destructive) { model.forgetDevice() }
                    .font(.system(size: 13, weight: .bold))
                    .frame(maxWidth: .infinity).padding(.vertical, 13)
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(ZColor.coral))
            }.padding(18)
        }
        .foregroundStyle(ZColor.ink).background(ZColor.paper)
        .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
        .padding(.horizontal, 8).padding(.bottom, 5)
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title.uppercased()).font(.system(size: 10, weight: .black)).foregroundStyle(ZColor.muted).padding(.bottom, 8)
            content()
        }
    }
    private func row(_ label: String, _ value: String) -> some View {
        HStack { Text(label).fontWeight(.semibold); Spacer(); Text(value).foregroundStyle(ZColor.muted) }
            .font(.system(size: 13)).padding(.vertical, 11)
            .overlay(alignment: .bottom) { Rectangle().fill(ZColor.line).frame(height: 1) }
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
        .font(.system(size: 13, weight: .semibold))
        .padding(.vertical, 8)
    }
}
