import SwiftUI

// 导航说明：RootView 仍是自绘 BottomBar + ZStack 条件切换，本轮明确不迁
// NavigationStack、不加边缘右滑返回手势（全屏 Feed 卡的手势与边缘返回冲突，
// 且详情页打开/关闭状态深嵌在 AppModel 中）。通知锁屏快捷操作
// （UNNotificationCategory）同属下一批，随推送路由升级一起做。
struct RootView: View {
    @ObservedObject var model: AppModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @AppStorage(PhoneSetupRules.dismissedKey) private var phoneSetupDismissed = false
    @AppStorage(PhoneSetupRules.hasEverPairedKey) private var hasEverPaired = false
    @State private var setupStep: PhoneSetupStep = .introduction
    @State private var manualSetupPresented = false
    @State private var feedResetRequest = 0

    var body: some View {
        Group {
            if showsPhoneSetup {
                phoneSetupFlow
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
                            if model.bridge.pairingRequired {
                                MacConnectionEmptyView(
                                    returningUser: hasEverPaired,
                                    onConnect: presentPhoneSetup
                                )
                            } else {
                                NativeFeedView(model: model, resetRequest: feedResetRequest)
                                    .ignoresSafeArea(.container, edges: .horizontal)
                            }
                        case .tasks: TasksDirectoryView(model: model)
                        case .agents: AgentsDirectoryView(model: model)
                        case .settings: SettingsView(model: model)
                        case .create: Color.clear
                        }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(ZColor.canvas)

                BottomBar(
                    model: model,
                    onConnectMac: presentPhoneSetup,
                    onFeedSelected: { feedResetRequest &+= 1 }
                )
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
                        statusColor: detailStatusColor,
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
                let session = model.conversationSessionId.flatMap { id in
                    model.snapshot.sessions.first { $0.id == id }
                }
                NewTaskView(
                    model: model,
                    session: session
                )
                    .environment(\.colorScheme, .dark)
                    .presentationDetents(session == nil ? [.medium, .large] : [.height(320), .medium])
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
                if !showing {
                    model.newTaskProjectId = nil
                    model.conversationSessionId = nil
                }
            }
            }
        }
        .onAppear { rememberExistingPairing() }
        .onChange(of: model.bridge.pairingRequired) { _, pairingRequired in
            guard !pairingRequired else { return }
            rememberExistingPairing()
        }
    }

    private var showsPhoneSetup: Bool {
        guard model.bridge.pairingRequired else { return false }
        return manualSetupPresented || PhoneSetupRules.root(
            pairingRequired: true,
            hasEverPaired: hasEverPaired,
            dismissed: phoneSetupDismissed
        ) == .firstRun
    }

    @ViewBuilder
    private var phoneSetupFlow: some View {
        switch setupStep {
        case .introduction:
            PhoneSetupIntroView(
                returningUser: hasEverPaired,
                showsCloseButton: manualSetupPresented,
                onDismiss: dismissPhoneSetup,
                onReadyToPair: { setupStep = .pairing }
            )
        case .pairing:
            PairingView(
                model: model,
                onCancel: { setupStep = .introduction },
                onPaired: rememberExistingPairing,
                showsExistingError: false
            )
            .background(ZColor.canvas.ignoresSafeArea())
        }
    }

    private func presentPhoneSetup() {
        clearDetail()
        setupStep = .introduction
        manualSetupPresented = true
    }

    private func dismissPhoneSetup() {
        if !manualSetupPresented { phoneSetupDismissed = true }
        manualSetupPresented = false
        setupStep = .introduction
    }

    private func rememberExistingPairing() {
        guard !model.bridge.pairingRequired else { return }
        hasEverPaired = true
        manualSetupPresented = false
        setupStep = .introduction
    }

    @ViewBuilder
    private var overlayBanner: some View {
        if model.bridge.pairingRequired {
            EmptyView()
        } else if model.pendingRouteSessionId != nil {
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
                        Circle().fill(outboxStatusColor).frame(width: 6, height: 6)
                        TimelineView(.periodic(from: .now, by: 30)) { _ in
                            Text(statusLine)
                        }
                        if model.failedOutboxCount > 0 {
                            Text("\(model.failedOutboxCount) 条失败").bold()
                        } else if model.waitingOutboxCount > 0 {
                            Text("\(model.waitingOutboxCount) 条").bold()
                        }
                        if !model.bridge.connected { Text("查看重连步骤").foregroundStyle(ZColor.muted) }
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 8) {
                            Circle().fill(outboxStatusColor).frame(width: 6, height: 6)
                            TimelineView(.periodic(from: .now, by: 30)) { _ in
                                Text(statusLine)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        HStack(spacing: 8) {
                            if model.failedOutboxCount > 0 { Text("\(model.failedOutboxCount) 条同步失败").bold() }
                            if model.waitingOutboxCount > 0 { Text("\(model.waitingOutboxCount) 条待确认").bold() }
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
        if model.failedOutboxCount > 0 {
            return model.waitingOutboxCount > 0
                ? "部分手机操作同步失败"
                : "手机操作同步失败，点按处理"
        }
        if model.bridge.connected {
            return model.waitingOutboxCount > 0 ? "手机操作正在等待运行设备确认" : "已与运行设备同步"
        }
        if let savedAt = model.snapshotSavedAt {
            return "当前离线 · 数据更新于 \(relative(savedAt))"
        }
        return "当前离线，操作已保存在手机"
    }

    private var outboxStatusColor: Color {
        if model.failedOutboxCount > 0 { return ZColor.coralText }
        return model.bridge.connected ? ZColor.sage : Color.orange
    }

    private func userFacingBridgeError(_ error: String) -> String {
        let normalized = error.lowercased()
        if normalized.contains("could not connect") || normalized.contains("connection refused") {
            return "无法连接运行设备，点按查看重连步骤"
        }
        if normalized.contains("timed out") || normalized.contains("timeout") {
            return "连接运行设备超时，点按查看重连步骤"
        }
        return error
    }

    private var isShowingDetail: Bool { model.selectedSession != nil || model.selectedProject != nil }

    private var overlayBottomPadding: CGFloat {
        if model.selectedSession != nil { return dynamicTypeSize.isAccessibilitySize ? 202 : 148 }
        return dynamicTypeSize.isAccessibilitySize ? 76 : 74
    }

    private var topBarTitle: String {
        if let session = model.selectedSession {
            let taskInput = TaskDetailProjection.originalInput(
                sessionTitle: session.title,
                sessionEvents: model.events[session.id] ?? []
            )
            return TaskHeaderRules.navigationTitle(sessionTitle: session.title, taskInput: taskInput)
        }
        if model.selectedProject != nil { return "Agent" }
        switch model.selectedTab {
        case .feed: return "Feed"
        case .tasks: return "任务"
        case .agents: return "Agents"
        case .settings: return "设置"
        case .create: return "新任务"
        }
    }

    private var detailStatus: String? {
        if selectedSessionState != nil { return TaskHeaderRules.stateLabel(selectedSessionState ?? "") }
        return nil
    }

    private var selectedSessionState: String? {
        guard let session = model.selectedSession else { return nil }
        guard !session.correlationUncertain else { return session.status }
        return model.snapshot.tasks.lazy
            .filter { $0.sessionId == session.id }
            .max { $0.updatedAt < $1.updatedAt }?
            .state ?? session.status
    }

    private var detailStatusColor: Color? {
        guard let state = selectedSessionState else { return nil }
        if ["failed", "waiting", "waiting_input", "user_review"].contains(state) { return ZColor.coralText }
        if ["running", "reviewing"].contains(state) { return ZColor.sageText }
        return ZColor.secondaryInk
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
    let onConnectMac: () -> Void
    let onFeedSelected: () -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        HStack(spacing: 0) {
            tabButton(.feed, "rectangle.stack.fill", "Feed")
            tabButton(.tasks, "checklist", "Tasks")
            CoreActionButton(state: coreActionState) { openComposer() }
            .frame(maxWidth: .infinity, minHeight: 44)
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
            if tab == .feed { onFeedSelected() }
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

    private var coreActionState: CoreActionMotionState {
        CoreActionMotionRules.state(
            connected: model.bridge.connected,
            isComposerPresented: model.showingNewTask,
            pendingActionCount: model.snapshot.actions.lazy.filter { $0.state == "pending" }.count,
            failedOutboxCount: model.failedOutboxCount,
            pendingOutboxCount: model.waitingOutboxCount,
            taskStates: model.snapshot.tasks.map(\.state),
            commandStates: model.snapshot.commands.map(\.state)
        )
    }

    private func openComposer() {
        Haptics.selection()
        guard !model.bridge.pairingRequired else {
            onConnectMac()
            return
        }
        if let session = model.selectedSession {
            model.conversationSessionId = session.id
            model.newTaskProjectId = projectID(for: session)
        } else if model.selectedProject != nil {
            model.conversationSessionId = nil
            model.newTaskProjectId = model.selectedProject?.id
        } else if model.selectedTab == .feed,
                  let id = model.activeFeedSessionId,
                  let session = model.snapshot.sessions.first(where: { $0.id == id }) {
            model.conversationSessionId = session.id
            model.newTaskProjectId = model.activeFeedProjectId ?? projectID(for: session)
        } else {
            model.conversationSessionId = nil
            model.newTaskProjectId = nil
        }
        model.showingNewTask = true
    }

    private func projectID(for session: AgentSession) -> String? {
        if let projectID = session.projectId { return projectID }
        guard let cwd = session.cwd else { return nil }
        return model.snapshot.projects.first(where: { project in
            project.paths.contains(where: { cwd == $0 || cwd.hasPrefix($0 + "/") })
        })?.id
    }

    private func tabSelected(_ tab: MainTab) -> Bool {
        model.selectedTab == tab && model.selectedSession == nil && model.selectedProject == nil
    }

    private func clearDetail() {
        model.selectedSession = nil
        model.selectedProject = nil
    }
}

private struct CoreActionButton: View {
    let state: CoreActionMotionState
    let action: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: action) {
            OrbitNodeMark(state: state)
                .frame(width: 60, height: 60)
                .contentShape(Rectangle())
                .accessibilityHidden(true)
        }
        .buttonStyle(CoreActionButtonStyle(reduceMotion: reduceMotion))
        .accessibilityLabel(Text("新任务"))
        .accessibilityValue(Text(state.accessibilityValue))
        .accessibilityHint(Text("打开任务输入框"))
    }
}

private struct CoreActionButtonStyle: ButtonStyle {
    let reduceMotion: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.90 : 1)
            .animation(
                reduceMotion ? nil : .spring(response: 0.24, dampingFraction: 0.68),
                value: configuration.isPressed
            )
    }
}

private struct OrbitNodeMark: View {
    let state: CoreActionMotionState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        TimelineView(.animation(
            minimumInterval: 1.0 / 24.0,
            paused: reduceMotion || scenePhase != .active || !state.animates
        )) { context in
            mark(at: reduceMotion ? 0 : context.date.timeIntervalSinceReferenceDate)
        }
    }

    private func mark(at time: TimeInterval) -> some View {
        let values = motionValues(at: time)
        let tone = state == .attention ? ZColor.coralText : state == .offline ? ZColor.muted : ZColor.sageText
        return ZStack {
            Circle()
                .fill(ZColor.raised)
                .overlay(Circle().stroke(ZColor.line, lineWidth: 1))
                .frame(width: 42, height: 42)
                .scaleEffect(values.nodeScale)

            OrbitArc()
                .stroke(tone.opacity(values.arcOpacity), style: StrokeStyle(lineWidth: 3.5, lineCap: .round))
                .frame(width: 52, height: 52)
                .rotationEffect(.degrees(values.rotation))

            satellite(tone: tone, values: values)

            Image(systemName: "plus")
                .font(.system(size: 19, weight: .bold))
                .foregroundStyle(state == .offline ? ZColor.muted : ZColor.ink)
        }
        .frame(width: 60, height: 60)
    }

    private func satellite(tone: Color, values: MotionValues) -> some View {
        let angle = (58 + values.rotation) * Double.pi / 180
        let radius = 26.0
        return Circle()
            .fill(tone)
            .frame(width: 6, height: 6)
            .scaleEffect(values.satelliteScale)
            .offset(x: cos(angle) * radius, y: sin(angle) * radius)
    }

    private func motionValues(at time: TimeInterval) -> MotionValues {
        let idleWave = (sin(time * 2 * .pi / 4.2) + 1) / 2
        let attentionWave = (sin(time * 2 * .pi / 1.8) + 1) / 2
        switch state {
        case .idle:
            return MotionValues(
                rotation: 0, nodeScale: 0.985 + idleWave * 0.025,
                arcOpacity: 0.68 + idleWave * 0.24,
                satelliteScale: 0.88 + idleWave * 0.16
            )
        case .active:
            return MotionValues(
                rotation: time.truncatingRemainder(dividingBy: 8) / 8 * 360,
                nodeScale: 1, arcOpacity: 0.94, satelliteScale: 1
            )
        case .attention:
            return MotionValues(
                rotation: sin(time * 2 * .pi / 3.2) * 5,
                nodeScale: 1, arcOpacity: 0.88 + attentionWave * 0.12,
                satelliteScale: 0.82 + attentionWave * 0.42
            )
        case .offline:
            return MotionValues(
                rotation: 0, nodeScale: 1, arcOpacity: 0.42,
                satelliteScale: 0.86
            )
        case .composing:
            return MotionValues(
                rotation: 16, nodeScale: 0.94, arcOpacity: 1,
                satelliteScale: 1
            )
        }
    }

    private struct MotionValues {
        let rotation: Double
        let nodeScale: Double
        let arcOpacity: Double
        let satelliteScale: Double
    }
}

private struct OrbitArc: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.addArc(
            center: CGPoint(x: rect.midX, y: rect.midY),
            radius: min(rect.width, rect.height) / 2,
            startAngle: .degrees(-92),
            endAngle: .degrees(58),
            clockwise: false
        )
        return path
    }
}

#if DEBUG
#Preview("轨道节点状态") {
    HStack(spacing: 18) {
        ForEach(CoreActionMotionState.allCases, id: \.self) { state in
            VStack(spacing: 4) {
                OrbitNodeMark(state: state).frame(width: 60, height: 60)
                Text(state.rawValue).font(.caption2).foregroundStyle(ZColor.muted)
            }
        }
    }
    .padding()
    .background(ZColor.canvas)
    .environment(\.colorScheme, .dark)
}
#endif
