import SwiftUI

struct RootView: View {
    @ObservedObject var model: AppModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        if model.bridge.pairingRequired {
            PairingView(model: model)
                .ignoresSafeArea()
        } else {
            VStack(spacing: 0) {
                Group {
                    if let session = model.selectedSession {
                        TaskDetailView(model: model, session: session)
                    } else if let project = model.selectedProject {
                        AgentDetailView(model: model, project: project)
                    } else {
                        switch model.selectedTab {
                        case .feed: NativeFeedView(model: model)
                        case .tasks: TasksDirectoryView(model: model)
                        case .agents: AgentsDirectoryView(model: model)
                        case .settings: SettingsView(model: model)
                        case .create: Color.clear
                        }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(ZColor.ink)

                BottomBar(model: model)
                    .background(ZColor.ink)
            }
            .background(ZColor.ink.ignoresSafeArea())
            .safeAreaInset(edge: .top, spacing: 0) {
                ZStack(alignment: .top) {
                    AppTopBar(
                        title: topBarTitle,
                        connected: model.bridge.connected,
                        connectionLabel: connectionLabel,
                        onBack: isShowingDetail ? clearDetail : nil,
                        status: detailStatus
                    )
                    VStack(spacing: 8) {
                        if model.pendingOutboxCount > 0 || !model.bridge.connected {
                            HStack(spacing: 8) {
                                Circle().fill(model.bridge.connected ? ZColor.acid : Color.orange).frame(width: 6, height: 6)
                                Text(model.bridge.connected ? "手机操作正在等待 Mac 确认" : "当前离线，操作已保存在手机")
                                if model.pendingOutboxCount > 0 { Text("\(model.pendingOutboxCount) 条").bold() }
                            }
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(ZColor.ink)
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .background(.thinMaterial)
                            .clipShape(Capsule())
                        }
                        if let error = model.bridge.error {
                            Text(error)
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 14).padding(.vertical, 9)
                                .background(ZColor.coral)
                                .clipShape(Capsule())
                        }
                    }
                    .offset(y: AppTopBar.contentHeight(for: dynamicTypeSize) + 8)
                    .padding(.horizontal, 14)
                    .allowsHitTesting(false)
                    .zIndex(2)
                }
            }
            .overlay(alignment: .bottom) {
                if let notice = model.notice {
                    Text(notice)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(ZColor.ink)
                        .padding(.horizontal, 16).padding(.vertical, 11)
                        .background(ZColor.acid)
                        .clipShape(Capsule())
                        .padding(.bottom, 74)
                        .task {
                            try? await Task.sleep(for: .seconds(4))
                            if model.notice == notice { model.notice = nil }
                        }
                }
            }
            .sheet(isPresented: $model.showingNewTask) {
                NewTaskView(model: model)
                    .presentationDetents([.large])
                    .presentationDragIndicator(.visible)
                    .presentationBackground(ZColor.paper)
            }
            .onChange(of: model.showingNewTask) { _, showing in
                if !showing { model.newTaskProjectId = nil }
            }
        }
    }

    private var isShowingDetail: Bool { model.selectedSession != nil || model.selectedProject != nil }

    private var topBarTitle: String {
        if let session = model.selectedSession { return session.title }
        if let project = model.selectedProject { return project.agentProfile.displayName }
        switch model.selectedTab {
        case .feed: return "Feed"
        case .tasks: return "任务"
        case .agents: return "Agents"
        case .settings: return "设置"
        case .create: return "新任务"
        }
    }

    private var detailStatus: String? {
        if let session = model.selectedSession {
            return ["running": "进行中", "waiting": "等待中", "failed": "失败", "completed": "已完成"][session.status] ?? session.status
        }
        return model.selectedProject == nil ? nil : "Agent"
    }

    private var connectionLabel: String {
        switch model.bridge.connectionMode {
        case "cloud": return "云端"
        case "local": return "本地"
        default: return "重连"
        }
    }

    private func clearDetail() {
        model.selectedSession = nil
        model.selectedProject = nil
    }
}

private struct BottomBar: View {
    @ObservedObject var model: AppModel

    var body: some View {
        HStack(spacing: 0) {
            tabButton(.feed, "rectangle.stack.fill", "Feed")
            tabButton(.tasks, "checklist", "Tasks")
            Button {
                model.showingNewTask = true
            } label: {
                VStack(spacing: 4) {
                    Image(systemName: "plus")
                        .font(.system(size: 21, weight: .black))
                        .frame(width: 43, height: 36)
                        .foregroundStyle(ZColor.ink)
                        .background(ZColor.acid)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    Text("新任务").font(.system(size: 9, weight: .bold))
                }
            }
            .frame(maxWidth: .infinity)
            .foregroundStyle(.white.opacity(0.66))
            tabButton(.agents, "person.2.fill", "Agents")
            Button {
                clearDetail()
                model.selectedTab = .settings
            } label: {
                VStack(spacing: 3) {
                    UserAvatar(id: model.snapshot.userProfile.avatarId, size: 26)
                    Text("设置").font(.system(size: 9, weight: .bold))
                }
                .foregroundStyle(model.selectedTab == .settings && model.selectedSession == nil ? ZColor.acid : .white.opacity(0.52))
            }
            .frame(maxWidth: .infinity)
        }
        .frame(height: 64)
        .background(ZColor.ink)
    }

    private func tabButton(_ tab: MainTab, _ icon: String, _ title: String) -> some View {
        Button {
            clearDetail()
            model.selectedTab = tab
        } label: {
            VStack(spacing: 4) {
                Image(systemName: icon).font(.system(size: 19, weight: .semibold))
                Text(title).font(.system(size: 9, weight: .bold))
            }
            .foregroundStyle(model.selectedTab == tab && model.selectedSession == nil && model.selectedProject == nil ? ZColor.acid : .white.opacity(0.52))
        }
        .frame(maxWidth: .infinity)
    }

    private func clearDetail() {
        model.selectedSession = nil
        model.selectedProject = nil
    }
}
