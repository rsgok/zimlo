import SwiftUI

struct RootView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        GeometryReader { geometry in
            if model.bridge.pairingRequired {
                PairingView(model: model)
                    .ignoresSafeArea()
            } else {
                VStack(spacing: 0) {
                    PageHeader(connected: model.bridge.connected)
                        .padding(.top, geometry.safeAreaInsets.top)
                        .background(ZColor.ink)

                    if model.pendingOutboxCount > 0 || !model.bridge.connected {
                        HStack {
                            Text(model.bridge.connected ? "正在同步手机指令" : "当前离线，操作已保存在手机")
                            Spacer()
                            if model.pendingOutboxCount > 0 { Text("\(model.pendingOutboxCount) 条待确认").bold() }
                        }
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(ZColor.ink)
                        .padding(.horizontal, 16).frame(height: 28)
                        .background(ZColor.acid)
                    }

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
                        .padding(.bottom, geometry.safeAreaInsets.bottom)
                        .background(ZColor.ink)
                }
                .ignoresSafeArea()
                .overlay(alignment: .top) {
                    if let error = model.bridge.error {
                        Text(error)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 14).padding(.vertical, 10)
                            .background(ZColor.coral)
                            .clipShape(Capsule())
                            .padding(.top, geometry.safeAreaInsets.top + 66)
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
                            .padding(.bottom, geometry.safeAreaInsets.bottom + 74)
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
