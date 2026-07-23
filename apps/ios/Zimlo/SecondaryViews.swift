import SwiftUI

struct TasksDirectoryView: View {
    @ObservedObject var model: AppModel
    @State private var search = ""
    @State private var filter = "关注"
    private let filters = ["关注", "进行中", "最近"]

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 10) {
                TextField("搜索任务或项目", text: $search)
                    .textFieldStyle(.roundedBorder)
                Picker("筛选", selection: $filter) {
                    ForEach(filters, id: \.self) { Text($0).tag($0) }
                }.pickerStyle(.segmented)
            }
            .padding(14)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    ForEach(projectGroups, id: \.project.id) { group in
                        VStack(alignment: .leading, spacing: 0) {
                            HStack {
                                Text(group.project.agentProfile.avatar).font(.title2)
                                VStack(alignment: .leading) {
                                    Text(group.project.agentProfile.displayName).font(.system(size: 16, weight: .black))
                                    Text(group.project.name).font(.system(size: 10, weight: .medium)).foregroundStyle(ZColor.muted)
                                }
                                Spacer()
                                Text("\(group.sessions.count)").font(.caption.bold()).foregroundStyle(ZColor.muted)
                            }.padding(14)
                            ForEach(group.sessions) { session in
                                HStack(spacing: 8) {
                                    Button { model.openTask(sessionId: session.id) } label: {
                                        HStack(spacing: 12) {
                                            Circle().fill(statusColor(session)).frame(width: 8, height: 8)
                                            VStack(alignment: .leading, spacing: 4) {
                                                Text(session.title).font(.system(size: 14, weight: .bold)).lineLimit(2)
                                                Text("\(session.runtimeLabel) · \(relative(session.lastActivityAt))")
                                                    .font(.system(size: 10, weight: .medium)).foregroundStyle(ZColor.muted)
                                            }
                                            Spacer()
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
                        .background(Color.white.opacity(0.45))
                        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                    }
                }.padding(12)
            }.scrollIndicators(.hidden)
        }
        .foregroundStyle(ZColor.ink).background(ZColor.paper)
        .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
        .padding(.horizontal, 8).padding(.bottom, 5)
    }

    private var projectGroups: [(project: Project, sessions: [AgentSession])] {
        model.snapshot.projects
            .sorted { $0.agentProfile.displayName.localizedStandardCompare($1.agentProfile.displayName) == .orderedAscending }
            .compactMap { project in
                let sessions = model.snapshot.sessions
                    .filter { $0.projectId == project.id && sessionVisible($0) }
                    .sorted { stableRank($0) < stableRank($1) }
                return sessions.isEmpty ? nil : (project, sessions)
            }
    }

    private func sessionVisible(_ session: AgentSession) -> Bool {
        let matchesSearch = search.isEmpty
            || session.title.localizedCaseInsensitiveContains(search)
            || session.projectName?.localizedCaseInsensitiveContains(search) == true
        guard matchesSearch else { return false }
        let preference = model.snapshot.taskPreferences.first { $0.sessionId == session.id }
        guard preference?.archivedAt == nil else { return false }
        switch filter {
        case "关注": return preference?.pinnedAt != nil || ["running", "waiting"].contains(session.status)
        case "进行中": return ["running", "waiting"].contains(session.status)
        default: return true
        }
    }

    private func stableRank(_ session: AgentSession) -> String {
        let pinned = model.snapshot.taskPreferences.first { $0.sessionId == session.id }?.pinnedAt != nil ? "0" : "1"
        let active = ["running", "waiting"].contains(session.status) ? "0" : "1"
        return "\(pinned):\(active):\(session.createdAt):\(session.id)"
    }

    private func statusColor(_ session: AgentSession) -> Color {
        if ["running", "waiting"].contains(session.status) { return ZColor.acid }
        if session.status == "failed" { return ZColor.coral }
        return ZColor.muted.opacity(0.5)
    }
}

struct AgentsDirectoryView: View {
    @ObservedObject var model: AppModel
    @State private var search = ""

    var body: some View {
        VStack(spacing: 0) {
            TextField("搜索 Project Agent", text: $search)
                .textFieldStyle(.roundedBorder).padding(14)
            ScrollView {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                    ForEach(agents) { project in
                        Button { model.openAgent(projectId: project.id) } label: {
                            VStack(alignment: .leading, spacing: 10) {
                                Text(project.agentProfile.avatar).font(.system(size: 36))
                                    .frame(width: 56, height: 56).background(ZColor.acid.opacity(0.34)).clipShape(Circle())
                                Text(project.agentProfile.displayName).font(.system(size: 16, weight: .black)).lineLimit(1)
                                Text(project.agentProfile.bio.isEmpty ? project.primaryPath : project.agentProfile.bio)
                                    .font(.system(size: 11, weight: .medium)).foregroundStyle(ZColor.muted).lineLimit(3)
                                Spacer()
                                Text("\(project.sessionCount) 个任务 · \(project.postCount) 条动态")
                                    .font(.system(size: 9, weight: .bold)).foregroundStyle(ZColor.sage)
                            }
                            .padding(14).frame(maxWidth: .infinity, minHeight: 180, alignment: .leading)
                            .foregroundStyle(ZColor.ink)
                            .background(Color.white.opacity(0.5))
                            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                        }
                    }
                }.padding(12)
            }.scrollIndicators(.hidden)
        }
        .background(ZColor.paper)
        .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
        .padding(.horizontal, 8).padding(.bottom, 5)
    }

    private var agents: [Project] {
        model.snapshot.projects
            .filter { search.isEmpty || $0.agentProfile.displayName.localizedCaseInsensitiveContains(search) || $0.name.localizedCaseInsensitiveContains(search) }
            .sorted { $0.agentProfile.displayName.localizedStandardCompare($1.agentProfile.displayName) == .orderedAscending }
    }
}

struct AgentDetailView: View {
    @ObservedObject var model: AppModel
    let project: Project
    @State private var editing = false

    private var sessions: [AgentSession] { model.snapshot.sessions.filter { $0.projectId == project.id } }
    private var posts: [FeedPost] { model.snapshot.posts.filter { $0.projectId == project.id }.sorted { $0.createdAt > $1.createdAt } }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button { model.selectedProject = nil } label: { Image(systemName: "arrow.left").fontWeight(.bold) }
                Spacer()
                Button { model.newTaskProjectId = project.id; model.showingNewTask = true } label: {
                    Label("布置任务", systemImage: "plus").font(.system(size: 12, weight: .black))
                }
                Button { editing = true } label: { Image(systemName: "pencil").fontWeight(.bold) }
            }
            .padding(.horizontal, 16).frame(height: 50)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(alignment: .top, spacing: 14) {
                        Text(project.agentProfile.avatar).font(.system(size: 40))
                            .frame(width: 70, height: 70).background(ZColor.acid.opacity(0.4)).clipShape(Circle())
                        VStack(alignment: .leading, spacing: 5) {
                            Text(project.agentProfile.displayName).font(.system(size: 25, weight: .black))
                            Text(project.name).font(.system(size: 11, weight: .semibold)).foregroundStyle(ZColor.muted)
                            Text(project.agentProfile.bio).font(.system(size: 13, weight: .medium)).lineLimit(3)
                        }
                    }.padding(18)
                    HStack {
                        metric("\(sessions.filter { ["running", "waiting"].contains($0.status) }.count)", "进行中")
                        metric("\(sessions.count)", "任务")
                        metric(project.agentProfile.defaultProvider?.label ?? "自动", "默认 Runtime")
                    }
                    .padding(.horizontal, 18).padding(.bottom, 14)
                    Rectangle().fill(ZColor.line).frame(height: 1)
                    Text("动态").font(.system(size: 20, weight: .black)).padding(18)
                    ForEach(posts) { post in
                        Button {
                            if let sessionId = post.sessionId { model.openTask(sessionId: sessionId) }
                        } label: {
                            HStack(alignment: .top, spacing: 10) {
                                Text(project.agentProfile.avatar).font(.title3)
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
                Section("身份") {
                    TextField("头像（Emoji 或文字）", text: $avatar)
                    TextField("Agent 名称", text: $displayName)
                    TextField("一句话简介", text: $bio, axis: .vertical).lineLimit(3...6)
                }
                Section("默认 Runtime") {
                    Picker("Runtime", selection: $provider) {
                        Text("自动选择").tag("")
                        Text("Codex").tag("codex")
                        Text("Claude Code").tag("claude")
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
                section("连接") {
                    row("Bridge", model.bridge.connected ? "实时连接" : "正在重连")
                    row("待同步指令", "\(model.pendingOutboxCount)")
                    row("协议", "Secure WS · v2")
                }
                section("运行边界") {
                    row("可信项目", "\(model.snapshot.workspaces.count)")
                    row("Codex / Claude Code", "GUI 与 CLI 分开识别")
                    row("手机审批", model.snapshot.lanApprovalsEnabled ? "已由 Mac 授权" : "未授权")
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
}
