import SwiftUI

// 导航说明：RootView 仍是自绘 BottomBar + ZStack 条件切换，本轮明确不迁
// NavigationStack、不加边缘右滑返回手势（全屏 Feed 卡的手势与边缘返回冲突，
// 且详情页打开/关闭状态深嵌在 AppModel 中）。通知锁屏快捷操作
// （UNNotificationCategory）同属下一批，随推送路由升级一起做。
struct RootView: View {
    @ObservedObject var model: AppModel

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
                        case .feed:
                            NativeFeedView(model: model)
                                .ignoresSafeArea(.container, edges: .horizontal)
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
                // 详情 header 是页面结构，需要正常占位；连接、通知和错误消息是
                // 浮层，不能通过 safeAreaInset 改变所有页面的内容坐标。
                if isShowingDetail {
                    AppTopBar(
                        title: topBarTitle,
                        connected: model.bridge.connected,
                        connectionLabel: connectionLabel,
                        onBack: clearDetail,
                        status: detailStatus,
                        onRetry: { model.bridge.retryNow() }
                    )
                }
            }
            .overlay(alignment: .bottom) {
                VStack(spacing: 8) {
                    statusBanners
                    if let notice = model.notice {
                        HStack(spacing: 12) {
                            Text(notice).lineLimit(2)
                            if let action = model.noticeAction {
                                Button(action.label) {
                                    model.clearNotice()
                                    action.perform()
                                }
                                .font(ZFont.caption)
                                .padding(.horizontal, 10).padding(.vertical, 6)
                                .background(ZColor.ink)
                                .foregroundStyle(ZColor.acid)
                                .clipShape(Capsule())
                            }
                        }
                        .font(ZFont.caption)
                        .foregroundStyle(ZColor.ink)
                        .padding(.horizontal, 16).padding(.vertical, 11)
                        .background(ZColor.acid)
                        .clipShape(Capsule())
                        .task(id: notice) {
                            // 带撤销操作的提示停留 6 秒，普通提示 4 秒。
                            try? await Task.sleep(for: .seconds(model.noticeAction == nil ? 4 : 6))
                            model.clearNotice(notice)
                        }
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 14)
                .padding(.bottom, 74)
                .zIndex(10)
            }
            .sheet(isPresented: $model.showingNewTask) {
                NewTaskView(model: model)
                    .presentationDetents([.large])
                    .presentationDragIndicator(.visible)
                    .presentationBackground(ZColor.paper)
            }
            .sheet(isPresented: $model.showingOutbox) {
                OutboxView(model: model)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
                    .presentationBackground(ZColor.paper)
            }
            .onChange(of: model.showingNewTask) { _, showing in
                if !showing { model.newTaskProjectId = nil }
            }
        }
    }

    @ViewBuilder
    private var statusBanners: some View {
        if model.pendingRouteSessionId != nil {
            // 通知路由占位条：session 未同步到本机前持久显示，可重试。
            HStack(spacing: 10) {
                Text("通知的任务尚未同步到手机")
                Spacer()
                Button("重试") { model.retryPendingRoute() }
                Button("任务列表") { model.goToTasksForPendingRoute() }
            }
            .font(ZFont.caption)
            .foregroundStyle(ZColor.ink)
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(ZColor.paper)
            .clipShape(Capsule())
        }
        if model.pendingOutboxCount > 0 || !model.bridge.connected {
            Button {
                if !model.bridge.connected { model.bridge.retryNow() }
                if model.pendingOutboxCount > 0 { model.showingOutbox = true }
            } label: {
                HStack(spacing: 8) {
                    Circle().fill(model.bridge.connected ? ZColor.sage : Color.orange).frame(width: 6, height: 6)
                    TimelineView(.periodic(from: .now, by: 30)) { _ in
                        Text(statusLine)
                    }
                    if model.pendingOutboxCount > 0 { Text("\(model.pendingOutboxCount) 条").bold() }
                    if !model.bridge.connected { Text("点按重连").foregroundStyle(ZColor.muted) }
                }
            }
            .font(ZFont.caption2)
            .foregroundStyle(ZColor.ink)
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(ZColor.paper)
            .clipShape(Capsule())
        }
        if let error = model.bridge.error {
            Text(userFacingBridgeError(error))
                .font(ZFont.caption)
                .foregroundStyle(.white)
                .padding(.horizontal, 14).padding(.vertical, 9)
                .background(ZColor.coral)
                .clipShape(Capsule())
        }
    }

    private var statusLine: String {
        if model.bridge.connected {
            return model.pendingOutboxCount > 0 ? "手机操作正在等待 Mac 确认" : "当前离线，操作已保存在手机"
        }
        if let savedAt = model.snapshotSavedAt {
            return "当前离线 · 数据更新于 \(relative(savedAt))"
        }
        return "当前离线，操作已保存在手机"
    }

    private func userFacingBridgeError(_ error: String) -> String {
        let normalized = error.lowercased()
        if normalized.contains("could not connect") || normalized.contains("connection refused") {
            return "无法连接 Mac，请确认 Bridge 正在运行"
        }
        if normalized.contains("timed out") || normalized.contains("timeout") {
            return "连接 Mac 超时，点按上方状态重试"
        }
        return error
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

    private var connectionLabel: String? {
        switch model.bridge.connectionMode {
        case "cloud": return "云端"
        case "local": return "本地"
        default: return nil
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
                        .font(.title3.weight(.black))
                        .frame(width: 43, height: 36)
                        .foregroundStyle(ZColor.ink)
                        .background(ZColor.acid)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    Text("新任务").font(ZFont.caption2)
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
                    Text("设置").font(ZFont.caption2)
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
                Image(systemName: icon).font(.body.weight(.semibold))
                Text(title).font(ZFont.caption2)
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
