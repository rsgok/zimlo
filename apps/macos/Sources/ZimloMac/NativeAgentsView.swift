import SwiftUI

struct NativeAgentsView: View {
    @ObservedObject var store: NativeAppStore
    @State private var query = ""

    private var projects: [Project] {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return store.snapshot.projects
            .filter { project in
                normalized.isEmpty || [project.name, project.primaryPath, project.agentProfile.displayName, project.agentProfile.bio]
                    .contains { $0.lowercased().contains(normalized) }
            }
            .sorted { $0.lastUsedAt > $1.lastUsedAt }
    }

    private let columns = [GridItem(.adaptive(minimum: 260, maximum: 380), spacing: 14)]

    var body: some View {
        ScrollView {
            LazyVGrid(columns: columns, spacing: 14) {
                ForEach(projects) { project in
                    NavigationLink(value: NativeRoute.agent(project.id)) {
                        NativeAgentCard(store: store, project: project)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(24)
        }
        .background(NativeTheme.paper)
        .navigationTitle("Agents")
        .searchable(text: $query, placement: .toolbar, prompt: "搜索 Agent 或项目")
        .overlay {
            if projects.isEmpty {
                ContentUnavailableView(
                    query.isEmpty ? "还没有 Agent" : "没有匹配的 Agent",
                    systemImage: "person.2",
                    description: Text(query.isEmpty ? "在 Codex 或 Claude Code 中打开项目后，Agent 会出现在这里。" : "换一个名称或路径试试。")
                )
                .foregroundStyle(NativeTheme.muted)
            }
        }
    }
}

private struct NativeAgentCard: View {
    @ObservedObject var store: NativeAppStore
    let project: Project

    private var active: Int {
        store.snapshot.sessions.filter {
            $0.projectId == project.id && ["running", "waiting"].contains($0.status)
        }.count
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 13) {
                NativeAgentAvatar(avatar: project.agentProfile.avatar, size: 52)
                VStack(alignment: .leading, spacing: 3) {
                    Text(project.agentProfile.displayName)
                        .font(.system(size: 18, weight: .bold, design: .rounded))
                        .foregroundStyle(NativeTheme.ink)
                    Text(project.name)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(NativeTheme.muted)
                }
                Spacer()
                if active > 0 {
                    Label("\(active) 工作中", systemImage: "bolt.fill")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(NativeTheme.sage)
                }
            }
            Text(project.agentProfile.bio.isEmpty ? "还没有设置专长与工作方式。" : project.agentProfile.bio)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(NativeTheme.ink.opacity(project.agentProfile.bio.isEmpty ? 0.44 : 0.72))
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack {
                Label("\(project.sessionCount) 个任务", systemImage: "checklist")
                Spacer()
                Text(project.agentProfile.defaultProvider?.label ?? "自动选择 Runtime")
            }
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(NativeTheme.muted)
        }
        .padding(18)
        .frame(maxWidth: .infinity, minHeight: 178, alignment: .topLeading)
        .nativeCard(cornerRadius: 17)
    }
}

struct NativeAgentProfileView: View {
    @ObservedObject var store: NativeAppStore
    let project: Project
    let onNewTask: () -> Void
    @State private var editing = false

    private var sessions: [AgentSession] {
        store.snapshot.sessions.filter { $0.projectId == project.id }
    }
    private var activeCount: Int {
        sessions.filter { ["running", "waiting"].contains($0.status) }.count
    }
    private var policy: ProjectTrustPolicy? {
        store.snapshot.trustPolicies.first { $0.projectId == project.id }
    }
    private var recentPosts: [FeedPost] {
        store.snapshot.posts.filter { $0.projectId == project.id }.sorted { $0.createdAt > $1.createdAt }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                profileHero
                HStack(alignment: .top, spacing: 14) {
                    workspaceCard
                    automationCard
                }
                importantUpdates
            }
            .padding(.horizontal, 28)
            .padding(.vertical, 24)
            .frame(maxWidth: 920, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .background(NativeTheme.paper)
        .navigationTitle(project.agentProfile.displayName)
        .toolbar {
            ToolbarItemGroup {
                Button(action: onNewTask) { Label("新任务", systemImage: "plus") }
                Button { editing = true } label: { Label("编辑资料", systemImage: "pencil") }
            }
        }
        .sheet(isPresented: $editing) {
            NativeAgentEditor(store: store, project: project)
        }
    }

    private var profileHero: some View {
        HStack(alignment: .top, spacing: 22) {
            NativeAgentAvatar(avatar: project.agentProfile.avatar, size: 82)
            VStack(alignment: .leading, spacing: 8) {
                Text(project.agentProfile.displayName)
                    .font(.system(size: 31, weight: .bold, design: .rounded))
                Text(project.agentProfile.bio.isEmpty ? "还没有设置专长与工作方式。编辑资料后，更容易理解这个 Agent 适合做什么。" : project.agentProfile.bio)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(NativeTheme.ink.opacity(0.67))
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 22) {
                    NativeProfileMetric(value: "\(activeCount)", label: "正在工作")
                    NativeProfileMetric(value: "\(project.sessionCount)", label: "历史任务")
                    NativeProfileMetric(value: project.agentProfile.defaultProvider?.label ?? "自动", label: "默认 Runtime")
                }
                .padding(.top, 7)
            }
            Spacer(minLength: 20)
        }
        .padding(22)
        .nativeCard(cornerRadius: 19)
    }

    private var workspaceCard: some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack {
                Label("工作目录", systemImage: "folder.fill")
                    .font(.system(size: 12, weight: .bold))
                Spacer()
                Button("复制") { NSPasteboard.general.setString(project.primaryPath, forType: .string) }
                    .buttonStyle(.plain)
                    .foregroundStyle(NativeTheme.acid)
            }
            Text(project.primaryPath)
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(NativeTheme.ink.opacity(0.72))
                .textSelection(.enabled)
                .lineLimit(3)
            Text("新任务默认使用主目录")
                .font(.system(size: 9.5, weight: .semibold))
                .foregroundStyle(NativeTheme.muted)
        }
        .padding(17)
        .frame(maxWidth: .infinity, minHeight: 132, alignment: .topLeading)
        .nativeCard(cornerRadius: 16)
    }

    private var automationCard: some View {
        VStack(alignment: .leading, spacing: 11) {
            Toggle(isOn: Binding(
                get: { policy?.preset == "safe_automation" },
                set: { enabled in Task { await store.setTrust(projectID: project.id, enabled: enabled) } }
            )) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("安全自动化").font(.system(size: 12, weight: .bold))
                    Text(policy?.preset == "safe_automation" ? "已允许项目内低风险动作" : "所有授权动作都会询问")
                        .font(.system(size: 9.5, weight: .medium))
                        .foregroundStyle(NativeTheme.muted)
                }
            }
            .toggleStyle(.switch)
            Text("安装、发布和破坏性操作始终需要确认。")
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(NativeTheme.ink.opacity(0.58))
        }
        .padding(17)
        .frame(maxWidth: .infinity, minHeight: 132, alignment: .topLeading)
        .nativeCard(cornerRadius: 16)
    }

    private var importantUpdates: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("重要动态").font(.system(size: 21, weight: .bold, design: .rounded))
                Spacer()
                Text("跨任务汇总 · 最新在上")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(NativeTheme.muted)
            }
            ForEach(recentPosts.prefix(6)) { post in
                Group {
                    if let sessionID = post.sessionId {
                        NavigationLink(value: NativeRoute.task(sessionID)) { updateRow(post) }.buttonStyle(.plain)
                    } else { updateRow(post) }
                }
            }
            if recentPosts.isEmpty {
                Text("这个 Agent 还没有发布值得汇总的动态。")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(NativeTheme.muted)
                    .padding(18)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .nativeCard()
            }
        }
    }

    private func updateRow(_ post: FeedPost) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Circle().fill(post.kind == "failure" ? NativeTheme.coral : NativeTheme.acid).frame(width: 8, height: 8).padding(.top, 5)
            VStack(alignment: .leading, spacing: 5) {
                Text(post.headline).font(.system(size: 14, weight: .bold)).foregroundStyle(NativeTheme.ink)
                Text(post.takeaway).font(.system(size: 11, weight: .medium)).foregroundStyle(NativeTheme.ink.opacity(0.66)).lineLimit(2)
            }
            Spacer()
            Text(post.createdAt.zimloDate, style: .relative)
                .font(.system(size: 9.5, weight: .semibold)).foregroundStyle(NativeTheme.muted)
        }
        .padding(15)
        .nativeCard(cornerRadius: 13)
    }
}

private struct NativeProfileMetric: View {
    let value: String
    let label: String
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value).font(.system(size: 15, weight: .bold, design: .rounded)).foregroundStyle(NativeTheme.ink)
            Text(label).font(.system(size: 9.5, weight: .semibold)).foregroundStyle(NativeTheme.muted)
        }
    }
}

private struct NativeAgentEditor: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var store: NativeAppStore
    let project: Project
    @State private var displayName: String
    @State private var avatar: String
    @State private var bio: String
    @State private var provider: Provider?
    @State private var saving = false

    init(store: NativeAppStore, project: Project) {
        self.store = store
        self.project = project
        _displayName = State(initialValue: project.agentProfile.displayName)
        _avatar = State(initialValue: project.agentProfile.avatar)
        _bio = State(initialValue: project.agentProfile.bio)
        _provider = State(initialValue: project.agentProfile.defaultProvider)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("编辑 Agent").font(.system(size: 17, weight: .bold, design: .rounded))
                Spacer()
                Button("取消") { dismiss() }
                Button(saving ? "保存中…" : "保存") {
                    saving = true
                    Task {
                        if await store.updateAgent(
                            projectID: project.id,
                            displayName: displayName.trimmingCharacters(in: .whitespacesAndNewlines),
                            avatar: avatar.trimmingCharacters(in: .whitespacesAndNewlines),
                            bio: bio.trimmingCharacters(in: .whitespacesAndNewlines),
                            provider: provider
                        ) { dismiss() }
                        saving = false
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(NativeTheme.acid)
                .disabled(displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || saving)
            }
            .padding(18)
            Divider().overlay(NativeTheme.border)
            Form {
                TextField("名称", text: $displayName)
                TextField("头像符号", text: $avatar)
                TextField("专长与工作方式", text: $bio, axis: .vertical).lineLimit(3...6)
                Picker("默认 Runtime", selection: $provider) {
                    Text("自动选择").tag(Provider?.none)
                    ForEach(Provider.allCases) { item in Text(item.label).tag(Provider?.some(item)) }
                }
            }
            .formStyle(.grouped)
            .scrollContentBackground(.hidden)
        }
        .frame(width: 520, height: 390)
        .background(NativeTheme.paper)
    }
}
