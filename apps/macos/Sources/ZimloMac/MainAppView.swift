import SwiftUI

struct MainAppView: View {
    let route: LocalBridgeRoute
    @ObservedObject var service: ServiceController

    @StateObject private var store: NativeAppStore
    @State private var section: NativeSection = .feed
    @State private var path: [NativeRoute] = []
    @State private var composer: NativeComposerContext?

    init(route: LocalBridgeRoute, service: ServiceController) {
        self.route = route
        self.service = service
        _store = StateObject(wrappedValue: NativeAppStore(
            client: .live(baseURL: route.baseURL)
        ))
    }

    var body: some View {
        ZStack {
            NativeTheme.paper.ignoresSafeArea()
            NavigationSplitView {
                NativeSidebarView(
                    selection: $section,
                    serviceState: service.state,
                    coreState: composer == nil
                        ? (service.isReady ? store.snapshot.coreState : .offline)
                        : .composing,
                    onCompose: { composer = NativeComposerContext() }
                )
                .navigationSplitViewColumnWidth(min: 210, ideal: 236, max: 270)
            } detail: {
                NavigationStack(path: $path) {
                    sectionRoot
                        .navigationDestination(for: NativeRoute.self) { route in
                            destination(for: route)
                        }
                }
            }
            .navigationSplitViewStyle(.balanced)

            loadOverlay

            if let composer {
                NativeComposerOverlay(
                    context: composer,
                    store: store,
                    onDismiss: { self.composer = nil }
                )
                .transition(.opacity.combined(with: .scale(scale: 0.985)))
                .zIndex(4)
            }

            if let notice = store.notice {
                NativeNoticeView(notice: notice)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .zIndex(6)
            }
        }
        .frame(minWidth: 920, minHeight: 640)
        .preferredColorScheme(.dark)
        .task { await store.run() }
        .onChange(of: section) { _, current in
            let isNotificationTaskRoute = current == .tasks && path.contains { route in
                if case .task = route { return true }
                return false
            }
            if !isNotificationTaskRoute {
                path.removeAll()
                MacNotificationManager.shared.setVisibleSessionID(nil)
            }
        }
        .onChange(of: path) { _, current in
            MacNotificationManager.shared.setVisibleSessionID(current.compactMap { route in
                if case .task(let sessionID) = route { return sessionID }
                return nil
            }.last)
        }
        .onReceive(NotificationCenter.default.publisher(for: .zimloOpenTask)) { notification in
            guard let sessionID = notification.object as? String else { return }
            section = .tasks
            path = [.task(sessionID)]
        }
        .onDisappear { MacNotificationManager.shared.setVisibleSessionID(nil) }
        .onChange(of: service.state) { _, current in
            guard current == .ready else { return }
            Task { await store.refresh() }
        }
        .animation(.snappy(duration: 0.24), value: composer != nil)
        .animation(.easeOut(duration: 0.18), value: store.notice)
    }

    @ViewBuilder
    private var sectionRoot: some View {
        switch section {
        case .feed:
            NativeFeedView(store: store)
        case .tasks:
            NativeTasksView(store: store)
        case .agents:
            NativeAgentsView(store: store)
        case .settings:
            NativeSettingsView(store: store, service: service)
        }
    }

    @ViewBuilder
    private func destination(for route: NativeRoute) -> some View {
        switch route {
        case .task(let sessionID):
            if let session = store.snapshot.sessions.first(where: { $0.id == sessionID }) {
                NativeTaskProfileView(
                    store: store,
                    session: session,
                    onReply: { composer = NativeComposerContext(sessionID: sessionID) }
                )
            } else {
                NativeMissingView(title: "这个任务已不存在", detail: "它可能已经从 Bridge 清理；返回列表即可继续。")
            }
        case .agent(let projectID):
            if let project = store.snapshot.projects.first(where: { $0.id == projectID }) {
                NativeAgentProfileView(
                    store: store,
                    project: project,
                    onNewTask: { composer = NativeComposerContext(projectID: projectID) }
                )
            } else {
                NativeMissingView(title: "这个 Agent 已不存在", detail: "项目可能已经移除或不再受信任。")
            }
        }
    }

    @ViewBuilder
    private var loadOverlay: some View {
        switch store.loadState {
        case .idle, .loading:
            NativeLoadingView(message: "正在连接本地 Zimlo…")
        case .failed(let message):
            NativeFailureView(message: message) {
                Task {
                    if !service.isReady { await service.retry() }
                    await store.refresh()
                }
            }
        case .loaded:
            EmptyView()
        }
    }
}

private struct NativeSidebarView: View {
    @Binding var selection: NativeSection
    let serviceState: ServiceState
    let coreState: CoreActionState
    let onCompose: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                NativeAppIcon(size: 34)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Zimlo").font(.system(size: 15, weight: .bold, design: .rounded))
                    Text(serviceState.label)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(serviceState == .ready ? NativeTheme.sage : NativeTheme.muted)
                }
                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.top, 12)
            .padding(.bottom, 16)

            List(NativeSection.allCases, selection: $selection) { item in
                Label {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(item.title).font(.system(size: 13, weight: .semibold))
                        Text(item.subtitle)
                            .font(.system(size: 9.5, weight: .medium))
                            .foregroundStyle(NativeTheme.muted)
                    }
                } icon: {
                    Image(systemName: item.symbol)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(selection == item ? NativeTheme.acid : NativeTheme.muted)
                        .frame(width: 19)
                }
                .tag(item)
                .padding(.vertical, 4)
            }
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)

            NativeCoreActionButton(state: coreState, action: onCompose)
                .padding(12)
        }
        .background(NativeTheme.surface.opacity(0.78))
    }
}

struct NativeMissingView: View {
    let title: String
    let detail: String

    var body: some View {
        ContentUnavailableView(title, systemImage: "questionmark.folder", description: Text(detail))
            .foregroundStyle(NativeTheme.ink)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(NativeTheme.paper)
    }
}

private struct NativeLoadingView: View {
    let message: String
    var body: some View {
        VStack(spacing: 13) {
            ProgressView().controlSize(.regular).tint(NativeTheme.acid)
            Text(message).font(.system(size: 13, weight: .semibold)).foregroundStyle(NativeTheme.muted)
        }
        .padding(24)
        .nativeCard()
        .shadow(color: .black.opacity(0.24), radius: 20, y: 8)
    }
}

private struct NativeFailureView: View {
    let message: String
    let retry: () -> Void
    var body: some View {
        VStack(spacing: 13) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 24, weight: .bold))
                .foregroundStyle(NativeTheme.coral)
            Text("本地服务暂时无法连接")
                .font(.system(size: 20, weight: .bold, design: .rounded))
            Text(message)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(NativeTheme.muted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 360)
            Button("重新连接", action: retry).buttonStyle(.borderedProminent).tint(NativeTheme.acid)
        }
        .padding(32)
        .nativeCard(cornerRadius: 20)
        .shadow(color: .black.opacity(0.28), radius: 24, y: 10)
    }
}

private struct NativeNoticeView: View {
    let notice: NativeNotice
    private var color: Color {
        switch notice.tone {
        case .neutral: NativeTheme.ink
        case .success: NativeTheme.sage
        case .failure: NativeTheme.coral
        }
    }

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: notice.tone == .failure ? "exclamationmark.circle.fill" : "checkmark.circle.fill")
                .foregroundStyle(color)
            Text(notice.text).font(.system(size: 12, weight: .semibold))
        }
        .foregroundStyle(NativeTheme.ink)
        .padding(.horizontal, 15)
        .frame(minHeight: 38)
        .background(.ultraThinMaterial)
        .clipShape(Capsule())
        .overlay(Capsule().stroke(color.opacity(0.25), lineWidth: 1))
        .shadow(color: .black.opacity(0.24), radius: 14, y: 5)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .padding(.top, 12)
        .allowsHitTesting(false)
    }
}
