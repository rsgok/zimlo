import SwiftUI

// 导航说明：RootView 仍是自绘 BottomBar + ZStack 条件切换，本轮明确不迁
// NavigationStack、不加边缘右滑返回手势（全屏 Feed 卡的手势与边缘返回冲突，
// 且详情页打开/关闭状态深嵌在 AppModel 中）。通知锁屏快捷操作
// （UNNotificationCategory）同属下一批，随推送路由升级一起做。
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
                .background(ZColor.canvas)

                BottomBar(model: model)
                    .background(ZColor.canvas)
            }
            .background(ZColor.canvas.ignoresSafeArea())
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
                // Status and notices are one overlay lane. Showing at most one
                // banner prevents stacked overlays from covering page controls,
                // and because this is an overlay it never shifts page geometry.
                overlayBanner
                .dynamicTypeSize(...DynamicTypeSize.accessibility1)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 14)
                .padding(.bottom, overlayBottomPadding)
                .zIndex(10)
            }
            .sheet(isPresented: $model.showingNewTask) {
                NewTaskView(model: model)
                    .environment(\.colorScheme, .dark)
                    .presentationDetents([.large])
                    .presentationDragIndicator(.visible)
                    .presentationBackground(ZColor.paper)
            }
            .sheet(isPresented: $model.showingOutbox) {
                OutboxView(model: model)
                    .environment(\.colorScheme, .dark)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
                    .presentationBackground(ZColor.paper)
            }
            .sheet(isPresented: $model.showingConnectionRecovery) {
                ConnectionRecoveryView(model: model)
                    .environment(\.colorScheme, .dark)
                    .presentationDetents([.large])
                    .presentationDragIndicator(.visible)
                    .presentationBackground(ZColor.paper)
            }
            .onChange(of: model.showingNewTask) { _, showing in
                if !showing { model.newTaskProjectId = nil }
            }
        }
    }

    @ViewBuilder
    private var overlayBanner: some View {
        if model.pendingRouteSessionId != nil {
            // 通知路由占位条：session 未同步到本机前持久显示，可重试。
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) {
                    Text("通知的任务尚未同步到手机")
                    Spacer()
                    pendingRouteButtons
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("通知的任务尚未同步到手机")
                    pendingRouteButtons
                }
            }
            .font(ZFont.caption)
            .foregroundStyle(ZColor.ink)
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(ZColor.paper)
            .clipShape(RoundedRectangle(cornerRadius: ZRadius.control, style: .continuous))
        } else if let notice = model.notice {
            let generation = model.noticeGeneration
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) {
                    Text(notice).lineLimit(2)
                    Spacer(minLength: 0)
                    if let action = model.noticeAction {
                        noticeButton(action)
                    }
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text(notice)
                        .fixedSize(horizontal: false, vertical: true)
                    if let action = model.noticeAction {
                        noticeButton(action)
                            .frame(maxWidth: .infinity, alignment: .trailing)
                    }
                }
            }
            .font(ZFont.caption)
            .foregroundStyle(ZColor.ink)
            .padding(.horizontal, 14).padding(.vertical, 8)
            .background(ZColor.raised)
            .overlay(RoundedRectangle(cornerRadius: ZRadius.control, style: .continuous).stroke(ZColor.sage.opacity(0.45)))
            .clipShape(RoundedRectangle(cornerRadius: ZRadius.control, style: .continuous))
            .task(id: generation) {
                // 带撤销操作的提示停留 6 秒，普通提示 4 秒。
                try? await Task.sleep(for: .seconds(model.noticeAction == nil ? 4 : 6))
                model.clearNotice(expectedGeneration: generation)
            }
        } else if let error = model.bridge.error {
            Button { model.showingConnectionRecovery = true } label: {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 9) {
                        Image(systemName: "exclamationmark.triangle.fill")
                        Text(userFacingBridgeError(error)).lineLimit(2)
                        Spacer(minLength: 0)
                        Text("处理").bold()
                    }
                    VStack(alignment: .leading, spacing: 5) {
                        Label(userFacingBridgeError(error), systemImage: "exclamationmark.triangle.fill")
                            .fixedSize(horizontal: false, vertical: true)
                        Text("查看重连步骤").bold()
                    }
                }
            }
            .font(ZFont.caption)
            .foregroundStyle(ZColor.ink)
            .padding(.horizontal, 14).padding(.vertical, 9)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .background(ZColor.coral)
            .clipShape(RoundedRectangle(cornerRadius: ZRadius.control, style: .continuous))
            .accessibilityHint("查看重连步骤，也可以使用新的连接码重新配对")
        } else if model.pendingOutboxCount > 0 || !model.bridge.connected {
            Button {
                if !model.bridge.connected {
                    model.showingConnectionRecovery = true
                } else if model.pendingOutboxCount > 0 {
                    model.showingOutbox = true
                }
            } label: {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) {
                        Circle().fill(model.bridge.connected ? ZColor.sage : Color.orange).frame(width: 6, height: 6)
                        TimelineView(.periodic(from: .now, by: 30)) { _ in
                            Text(statusLine)
                        }
                        if model.pendingOutboxCount > 0 { Text("\(model.pendingOutboxCount) 条").bold() }
                        if !model.bridge.connected { Text("查看重连步骤").foregroundStyle(ZColor.muted) }
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 8) {
                            Circle().fill(model.bridge.connected ? ZColor.sage : Color.orange).frame(width: 6, height: 6)
                            TimelineView(.periodic(from: .now, by: 30)) { _ in
                                Text(statusLine)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        HStack(spacing: 8) {
                            if model.pendingOutboxCount > 0 { Text("\(model.pendingOutboxCount) 条待确认").bold() }
                            if !model.bridge.connected { Text("查看重连步骤").foregroundStyle(ZColor.muted) }
                        }
                    }
                }
            }
            .font(ZFont.caption2)
            .foregroundStyle(ZColor.ink)
            .padding(.horizontal, 12).padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .background(ZColor.paper)
            .clipShape(RoundedRectangle(cornerRadius: ZRadius.control, style: .continuous))
        }
    }

    private var pendingRouteButtons: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                bannerActionButton("重试") { model.retryPendingRoute() }
                bannerActionButton("任务列表") { model.goToTasksForPendingRoute() }
            }
            VStack(spacing: 6) {
                bannerActionButton("重试") { model.retryPendingRoute() }
                bannerActionButton("任务列表") { model.goToTasksForPendingRoute() }
            }
        }
    }

    private func noticeButton(_ action: NoticeAction) -> some View {
        bannerActionButton(action.label) {
            model.clearNotice()
            action.perform()
        }
    }

    private func bannerActionButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .font(ZFont.caption.weight(.bold))
            .foregroundStyle(ZColor.acid)
            .padding(.horizontal, 12)
            .frame(minWidth: 44, minHeight: 44)
            .background(ZColor.canvas)
            .clipShape(RoundedRectangle(cornerRadius: ZRadius.small, style: .continuous))
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
            return "无法连接 Mac，点按查看重连步骤"
        }
        if normalized.contains("timed out") || normalized.contains("timeout") {
            return "连接 Mac 超时，点按查看重连步骤"
        }
        return error
    }

    private var isShowingDetail: Bool { model.selectedSession != nil || model.selectedProject != nil }

    private var overlayBottomPadding: CGFloat {
        if model.selectedSession != nil { return dynamicTypeSize.isAccessibilitySize ? 202 : 148 }
        return dynamicTypeSize.isAccessibilitySize ? 76 : 74
    }

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
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        HStack(spacing: 0) {
            tabButton(.feed, "rectangle.stack.fill", "Feed")
            tabButton(.tasks, "checklist", "Tasks")
            Button {
                model.showingNewTask = true
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: dynamicTypeSize.isAccessibilitySize ? 22 : 20, weight: .black))
                    .frame(width: 48, height: 44)
                    .foregroundStyle(ZColor.onAccent)
                    .background(ZColor.acid)
                    .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
            }
            .frame(maxWidth: .infinity, minHeight: 44)
            .foregroundStyle(ZColor.ink.opacity(0.66))
            .accessibilityLabel("新任务")
            tabButton(.agents, "person.2.fill", "Agents")
            Button {
                clearDetail()
                model.selectedTab = .settings
            } label: {
                if dynamicTypeSize.isAccessibilitySize {
                    UserAvatar(id: model.snapshot.userProfile.avatarId, size: 30)
                        .frame(width: 44, height: 44)
                        .overlay(Circle().stroke(settingsSelected ? ZColor.acid : Color.clear, lineWidth: 2))
                } else {
                    VStack(spacing: 3) {
                        UserAvatar(id: model.snapshot.userProfile.avatarId, size: 26)
                            .overlay(Circle().stroke(settingsSelected ? ZColor.acid : Color.clear, lineWidth: 2))
                        Text("设置").font(ZFont.caption2).lineLimit(1).minimumScaleFactor(0.72)
                    }
                }
            }
            .foregroundStyle(settingsSelected ? ZColor.acid : ZColor.ink.opacity(0.52))
            .frame(maxWidth: .infinity, minHeight: 44)
            .accessibilityLabel("设置")
            .accessibilityAddTraits(settingsSelected ? .isSelected : [])
        }
        .frame(height: 64)
        .background(ZColor.canvas)
    }

    private func tabButton(_ tab: MainTab, _ icon: String, _ title: String) -> some View {
        Button {
            clearDetail()
            model.selectedTab = tab
        } label: {
            if dynamicTypeSize.isAccessibilitySize {
                Image(systemName: icon)
                    .font(.system(size: 22, weight: .semibold))
                    .frame(width: 44, height: 44)
            } else {
                VStack(spacing: 4) {
                    Image(systemName: icon).font(.body.weight(.semibold))
                    Text(title).font(ZFont.caption2).lineLimit(1).minimumScaleFactor(0.72)
                }
            }
        }
        .foregroundStyle(model.selectedTab == tab && model.selectedSession == nil && model.selectedProject == nil ? ZColor.acid : ZColor.ink.opacity(0.52))
        .frame(maxWidth: .infinity, minHeight: 44)
        .accessibilityLabel(title)
        .accessibilityAddTraits(tabSelected(tab) ? .isSelected : [])
    }

    private var settingsSelected: Bool {
        model.selectedTab == .settings && model.selectedSession == nil && model.selectedProject == nil
    }

    private func tabSelected(_ tab: MainTab) -> Bool {
        model.selectedTab == tab && model.selectedSession == nil && model.selectedProject == nil
    }

    private func clearDetail() {
        model.selectedSession = nil
        model.selectedProject = nil
    }
}
