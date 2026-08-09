import Combine
import Foundation
import SwiftUI
import UIKit
import UserNotifications

enum MainTab: String, CaseIterable {
    case feed
    case tasks
    case create
    case agents
    case settings
}

struct FeedEntry: Identifiable, Hashable, FeedOrderable {
    enum Content: Hashable {
        case post(FeedPost)
        case action(PendingAction)
        case command(TaskCommand)
    }

    let id: String
    let createdAt: String
    let needsAction: Bool
    let unread: Bool
    let settledReview: Bool
    let priority: Int
    let sessionId: String?
    let content: Content
}

struct NoticeAction {
    let label: String
    let perform: () -> Void
}

enum EventBufferRules {
    static let timelineLimit = 500

    /// Keep the original task input even when a long-running session exceeds
    /// the rendering window. The remaining timeline is bounded to cap memory.
    static func bounded(_ values: [UnifiedEvent]) -> [UnifiedEvent] {
        let sorted = Dictionary(values.map { ($0.id, $0) }, uniquingKeysWith: { _, latest in latest })
            .values.sorted { $0.sequence < $1.sequence }
        var bounded = Array(sorted.suffix(timelineLimit))
        if let firstInstruction = sorted.first(where: { $0.kind == "user_instruction" }),
           !bounded.contains(where: { $0.id == firstInstruction.id }) {
            bounded.insert(firstInstruction, at: 0)
        }
        return bounded
    }
}

enum FeedDismissAcknowledgementRules {
    static func snapshotConfirmsUndo(_ entry: OutboxEntry, snapshot: Snapshot) -> Bool {
        guard entry.command.type == "feed.dismiss.set",
              entry.command.values["dismissed"] == .bool(false),
              case .string(let itemId) = entry.command.values["itemId"] else { return false }
        return !snapshot.dismissedFeedItemIds.contains(itemId)
    }
}

enum NotificationDeviceAcknowledgementRules {
    static func confirms(_ entry: OutboxEntry, registration: PushDeviceRegistration?) -> Bool {
        switch entry.command.type {
        case "notification.device.register": return registration != nil
        case "notification.device.unregister": return registration == nil
        default: return false
        }
    }
}

enum NotificationDeviceRevocationRules {
    static func hasPendingUnregister(_ entries: [OutboxEntry]) -> Bool {
        entries.contains { $0.command.type == "notification.device.unregister" }
    }
}

@MainActor
final class AppModel: ObservableObject {
    let bridge = BridgeClient()

    @Published var snapshot: Snapshot
    @Published var snapshotSavedAt: Date?
    @Published var events: [String: [UnifiedEvent]] = [:]
    @Published var selectedTab: MainTab = .feed
    @Published var selectedSession: AgentSession?
    @Published var selectedProject: Project?
    @Published var showingNewTask = false
    @Published var showingOutbox = false
    @Published var showingConnectionRecovery = false
    @Published var newTaskProjectId: String?
    @Published var conversationSessionId: String?
    @Published var activeFeedSessionId: String?
    @Published var activeFeedProjectId: String?
    @Published private(set) var notice: String?
    @Published private(set) var noticeAction: NoticeAction?
    @Published private(set) var noticeGeneration = 0
    @Published var notificationPermission = "正在检查"
    @Published private(set) var isForgettingDevice = false
    // 冷启动点通知时本地还没有这条 session：保留可重试路由，直到成功打开。
    @Published private(set) var pendingRouteSessionId: String?

    private var bridgeObserver: AnyCancellable?
    private var hostSnapshots: [String: Snapshot] = [:]
    @Published private var outbox: [OutboxEntry] = []
    private var outboxRetryTask: Task<Void, Never>?
    private var snapshotSaveTask: Task<Void, Never>?
    private var snapshotClearTask: Task<Void, Never>?
    private var forgetDeviceTask: Task<Void, Never>?
    private let snapshotWriter = SnapshotWriter()
    private let outboxKey = "zimlo.native.command-outbox.v1"

    init() {
        let cached = SnapshotCache.loadEnvelope()
        snapshot = cached?.snapshot ?? .empty
        snapshotSavedAt = cached?.savedAt
        pendingRouteSessionId = UserDefaults.standard.string(forKey: "zimlo.pending-push-route")
        outbox = (try? JSONDecoder().decode(
            [OutboxEntry].self,
            from: UserDefaults.standard.data(forKey: outboxKey) ?? Data()
        )) ?? []
        bridgeObserver = bridge.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
        bridge.onMessage = { [weak self] hostId, message in self?.apply(message, hostId: hostId) }
        NotificationManager.shared.onRegistration = { [weak self] token, publicKey in
            guard let self else { return }
            #if DEBUG
            let environment = "development"
            #else
            let environment = "production"
            #endif
            _ = self.sendDurableToAll(ClientCommand(type: "notification.device.register", [
                "token": .string(token),
                "publicKey": .string(publicKey),
                "environment": .string(environment),
                "idempotencyKey": .string(UUID().uuidString),
            ]))
        }
        NotificationManager.shared.onRoute = { [weak self] sessionId in
            guard let self else { return }
            self.routeToTask(sessionId: sessionId)
        }
        NotificationManager.shared.onError = { [weak self] message in self?.showNotice(message) }
        NotificationManager.shared.onQuickDecide = { [weak self] actionId, sessionId, decisionId, key in
            self?.quickDecide(actionId: actionId, sessionId: sessionId, decisionId: decisionId, idempotencyKey: key)
        }
        NotificationManager.shared.onQuickExpired = { [weak self] sessionId in
            guard let self else { return }
            self.showNotice("该审批已过期，请在任务中查看最新状态", action: NoticeAction(label: "查看任务") {
                self.routeToTask(sessionId: sessionId)
            })
        }
        Task { [weak self] in
            let status = await NotificationManager.shared.authorizationStatus()
            self?.notificationPermission = Self.notificationPermissionLabel(status)
        }
        bridge.onSecureConnection = { [weak self] hostId in
            guard let self else { return }
            self.flushOutbox(hostId: hostId)
            // Re-registering with APNs after a new pairing also publishes the
            // freshly rotated push-route public key to this Mac.
            Task { _ = await NotificationManager.shared.refreshRegistration() }
            _ = self.bridge.send(ClientCommand(type: "snapshot.request", [
                "afterSequence": .number(Double(self.snapshot.sequence)),
                "hostId": .string(hostId),
            ]))
            if let sessionId = self.selectedSession?.id {
                _ = self.bridge.send(self.routed(ClientCommand(type: "session.events.request", ["sessionId": .string(sessionId)])))
            }
        }
        outboxRetryTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                guard !Task.isCancelled, let self else { return }
                self.flushOutbox()
            }
        }
    }

    var pendingOutboxCount: Int {
        outbox.count { OutboxFeedbackRules.showsPendingStatus(commandType: $0.command.type) }
    }
    var failedOutboxCount: Int {
        outbox.count {
            $0.lastError != nil && OutboxFeedbackRules.showsPendingStatus(commandType: $0.command.type)
        }
    }
    var waitingOutboxCount: Int {
        outbox.count {
            $0.lastError == nil && OutboxFeedbackRules.showsPendingStatus(commandType: $0.command.type)
        }
    }
    var outboxEntries: [OutboxEntry] { outbox }

    func showNotice(_ text: String, action: NoticeAction? = nil) {
        notice = text
        noticeAction = action
        noticeGeneration &+= 1
    }

    func clearNotice(expectedGeneration: Int? = nil) {
        guard expectedGeneration == nil || noticeGeneration == expectedGeneration else { return }
        notice = nil
        noticeAction = nil
    }

    var feedEntries: [FeedEntry] {
        let dismissed = Set(snapshot.dismissedFeedItemIds)
        let seen = Set(snapshot.seenPostIds)
        // 每个任务（sessionId ?? taskId 分组）最新的 result/failure 时间，用于覆盖判定。
        var latestOutcomeByTask: [String: String] = [:]
        for post in snapshot.posts where FeedRules.outcomeKinds.contains(post.kind) {
            let key = post.sessionId ?? post.taskId
            if post.createdAt > (latestOutcomeByTask[key] ?? "") { latestOutcomeByTask[key] = post.createdAt }
        }

        var entries = FeedRules.mergeRoutinePosts(snapshot.posts).map { post -> FeedEntry in
            let unread = !seen.contains(post.id)
            let covered = FeedRules.isCovered(
                kind: post.kind,
                createdAt: post.createdAt,
                latestOutcomeCreatedAt: latestOutcomeByTask[post.sessionId ?? post.taskId]
            )
            return FeedEntry(
                id: "post:\(post.id)", createdAt: post.createdAt, needsAction: false,
                unread: unread, settledReview: false,
                priority: FeedRules.priority(kind: post.kind, needsAction: false, covered: covered, unread: unread),
                sessionId: post.sessionId, content: .post(post)
            )
        }
        entries += snapshot.actions
            .filter { $0.state == "pending" }
            .map {
                FeedEntry(
                    id: "action:\($0.actionId)", createdAt: $0.createdAt, needsAction: true,
                    unread: true, settledReview: false, priority: 0,
                    sessionId: $0.sessionId, content: .action($0)
                )
            }
        entries += snapshot.commands
            .filter { $0.kind == "create" && ["queued", "dispatching", "running", "failed"].contains($0.state) && $0.sessionId == nil }
            .map {
                FeedEntry(
                    id: "command:\($0.id)", createdAt: $0.createdAt, needsAction: $0.state == "failed",
                    unread: true, settledReview: false,
                    priority: $0.state == "failed" ? 0 : 5, sessionId: nil, content: .command($0)
                )
            }
        entries += outbox
            .filter { $0.command.type == "task.create" }
            .compactMap { entry -> FeedEntry? in
                guard case .string(let providerText) = entry.command.values["provider"],
                      case .string(let workspaceId) = entry.command.values["workspaceId"],
                      case .string(let text) = entry.command.values["text"],
                      let provider = Provider(rawValue: providerText) else { return nil }
                if snapshot.commands.contains(where: { $0.idempotencyKey == entry.command.idempotencyKey }) { return nil }
                let workspace = snapshot.workspaces.first { $0.id == workspaceId }
                let command = TaskCommand(
                    id: "local:\(entry.id)", idempotencyKey: entry.command.idempotencyKey ?? entry.id,
                    kind: "create", provider: provider, sessionId: nil, workspaceId: workspaceId,
                    cwd: workspace?.path ?? "", text: text, state: "queued",
                    createdAt: entry.enqueuedAt, updatedAt: entry.enqueuedAt, error: nil
                )
                return FeedEntry(
                    id: "command:\(command.id)", createdAt: command.createdAt, needsAction: false,
                    unread: true, settledReview: false, priority: 5,
                    sessionId: nil, content: .command(command)
                )
            }
        return FeedRules.stableSorted(entries.filter { !dismissed.contains($0.id) })
    }

    func start() { bridge.start() }
    func stop() {
        bridge.stop()
        flushSnapshotForBackground()
    }

    func openTask(sessionId: String) {
        guard let session = snapshot.sessions.first(where: { $0.id == sessionId }) else { return }
        selectedSession = session
        if pendingRouteSessionId == sessionId { clearPendingRoute() }
        _ = send(ClientCommand(type: "session.events.request", ["sessionId": .string(sessionId)]))
    }

    // 通知路由闭环：session 不在本地时保留路由并持久化，Feed 顶部占位条提供重试。
    private func routeToTask(sessionId: String) {
        if snapshot.sessions.contains(where: { $0.id == sessionId }) {
            openTask(sessionId: sessionId)
        } else {
            pendingRouteSessionId = sessionId
            UserDefaults.standard.set(sessionId, forKey: "zimlo.pending-push-route")
        }
    }

    func retryPendingRoute() {
        guard let sessionId = pendingRouteSessionId else { return }
        if snapshot.sessions.contains(where: { $0.id == sessionId }) {
            openTask(sessionId: sessionId)
        } else if bridge.connected {
            _ = bridge.sendToAll(ClientCommand(type: "snapshot.request", [
                "afterSequence": .number(Double(snapshot.sequence)),
            ]))
            showNotice("正在向 Mac 请求最新任务列表")
        } else {
            showNotice("尚未连接 Mac，恢复连接后会自动继续")
            bridge.retryNow()
        }
    }

    func goToTasksForPendingRoute() {
        selectedTab = .tasks
        selectedSession = nil
        selectedProject = nil
    }

    private func clearPendingRoute() {
        pendingRouteSessionId = nil
        UserDefaults.standard.removeObject(forKey: "zimlo.pending-push-route")
    }

    func openAgent(projectId: String) {
        selectedProject = snapshot.projects.first(where: { $0.id == projectId })
    }

    func markSeen(_ postId: String) {
        guard !snapshot.seenPostIds.contains(postId) else { return }
        snapshot.seenPostIds.append(postId)
        scheduleSnapshotSave()
        _ = sendDurable(ClientCommand(type: "feed.seen", ["postId": .string(postId)]))
    }

    func markTimelineSeen(sessionId: String, itemId: String) {
        snapshot.taskTimelineCursors[sessionId] = itemId
        scheduleSnapshotSave()
        _ = sendDurable(ClientCommand(type: "task.timeline.seen", [
            "sessionId": .string(sessionId),
            "itemId": .string(itemId),
        ]))
    }

    func dismiss(_ itemId: String) {
        if !snapshot.dismissedFeedItemIds.contains(itemId) {
            snapshot.dismissedFeedItemIds.append(itemId)
            scheduleSnapshotSave()
        }
        Haptics.destructiveLocalAction()
        _ = sendDurable(ClientCommand(type: "feed.dismiss.set", [
            "itemId": .string(itemId),
            "dismissed": .bool(true),
            "idempotencyKey": .string(UUID().uuidString),
        ]))
        showNotice("已移出 Feed", action: NoticeAction(label: "撤销", perform: { [weak self] in
            self?.undismiss(itemId)
        }))
    }

    // 撤销移除：乐观恢复本地状态；dismissed=false 没有增量回执，依赖快照调和，
    // 所以这条指令发送成功后即视为完成（fire-and-forget），失败则留在 outbox 重放。
    func undismiss(_ itemId: String) {
        snapshot.dismissedFeedItemIds.removeAll { $0 == itemId }
        scheduleSnapshotSave()
        _ = sendDurable(ClientCommand(type: "feed.dismiss.set", [
            "itemId": .string(itemId),
            "dismissed": .bool(false),
            "idempotencyKey": .string(UUID().uuidString),
        ]))
    }

    @discardableResult
    func createTask(provider: Provider, workspaceId: String, text: String, materialIds: [String] = []) -> Bool {
        let command = ClientCommand(type: "task.create", [
            "provider": .string(provider.rawValue),
            "workspaceId": .string(workspaceId),
            "text": .string(text),
            "materialIds": .array(materialIds.map(JSONValue.string)),
            "idempotencyKey": .string(UUID().uuidString),
        ])
        guard sendDurable(command) else { return false }
        selectedTab = .feed
        showingNewTask = false
        return true
    }

    // 返回是否已成功持久化到 outbox：成功时调用方在同一交互周期清空输入与草稿，
    // 本地 pending 展示由 localFollowUps / feedEntries 的 local: 条目立即给出；
    // 失败时返回 false，调用方保留原文。
    @discardableResult
    func followUp(sessionId: String, text: String, materialIds: [String] = []) -> Bool {
        sendDurable(ClientCommand(type: "task.follow_up", [
            "sessionId": .string(sessionId),
            "text": .string(text),
            "materialIds": .array(materialIds.map(JSONValue.string)),
            "idempotencyKey": .string(UUID().uuidString),
        ]))
    }

    func decide(action: PendingAction, decision: Decision, confirmation: String? = nil) {
        var values: [String: JSONValue] = [
            "actionId": .string(action.actionId),
            "sessionId": .string(action.sessionId),
            "decisionId": .string(decision.id),
            "idempotencyKey": .string(UUID().uuidString),
        ]
        if let confirmation { values["confirmationPhrase"] = .string(confirmation) }
        _ = sendDurable(ClientCommand(type: "action.decide", values))
    }

    // 锁屏快捷审批：通知 action 只带 id，没有完整 PendingAction/Decision，直接构造
    // decide 指令。确定性幂等键防连点与重复投递；服务端仍重校验 action 状态、设备
    // 权限与幂等键，终态失败走 action.result 的既有失败标记（停止重试并展示原因），
    // 成功确认由 apply 的既有逻辑播成功触觉。
    func quickDecide(actionId: String, sessionId: String, decisionId: String, idempotencyKey: String) {
        let persisted = sendDurable(ClientCommand(type: "action.decide", [
            "actionId": .string(actionId),
            "sessionId": .string(sessionId),
            "decisionId": .string(decisionId),
            "idempotencyKey": .string(idempotencyKey),
        ]))
        if persisted { Haptics.persisted() }
    }

    func updateTrustPolicy(projectId: String, preset: String) {
        _ = sendDurable(ClientCommand(type: "trust.policy.update", [
            "projectId": .string(projectId),
            "preset": .string(preset),
            "idempotencyKey": .string(UUID().uuidString),
        ]))
    }

    func updateNotificationSettings(_ settings: NotificationSettings) {
        _ = sendDurableToAll(ClientCommand(type: "notification.settings.update", [
            "settings": .object([
                "enabled": .bool(settings.enabled),
                "approvals": .bool(settings.approvals),
                "failures": .bool(settings.failures),
                "showTaskTitle": .bool(settings.showTaskTitle),
            ]),
            "idempotencyKey": .string(UUID().uuidString),
        ]))
    }

    func requestNotifications() {
        Task {
            _ = await NotificationManager.shared.requestAuthorization()
            // requestAuthorization(false) 同时覆盖“明确拒绝”和请求异常；以系统
            // 最终状态为准，确保用户首次点拒绝后立刻看到可操作的设置入口。
            let status = await NotificationManager.shared.authorizationStatus()
            let allowed = Self.notificationsAllowed(status)
            notificationPermission = Self.notificationPermissionLabel(status)
            var settings = snapshot.notificationSettings
            settings.enabled = allowed
            updateNotificationSettings(settings)
            if status == .denied {
                showNotice("通知已被系统拒绝，可在设置页直接打开系统设置。")
            } else if !allowed {
                showNotice("通知未开启，请稍后重试。")
            }
        }
    }

    func refreshNotificationPermission() {
        Task {
            let status = await NotificationManager.shared.authorizationStatus()
            notificationPermission = Self.notificationPermissionLabel(status)
        }
    }

    private static func notificationPermissionLabel(_ status: UNAuthorizationStatus) -> String {
        switch status {
        case .authorized, .provisional, .ephemeral: return "系统已允许"
        case .denied: return "系统已拒绝"
        case .notDetermined: return "尚未请求"
        @unknown default: return "状态未知"
        }
    }

    private static func notificationsAllowed(_ status: UNAuthorizationStatus) -> Bool {
        [.authorized, .provisional, .ephemeral].contains(status)
    }

    @discardableResult
    func submitInput(action: PendingAction, answer: String) -> Bool {
        sendDurable(ClientCommand(type: "action.decide", [
            "actionId": .string(action.actionId),
            "sessionId": .string(action.sessionId),
            "decisionId": .string("submit-input"),
            "idempotencyKey": .string(UUID().uuidString),
            "input": .object(["answer": .string(answer)]),
        ]))
    }

    func updateAvatar(_ id: String) {
        snapshot.userProfile.avatarId = id
        scheduleSnapshotSave()
        _ = sendDurableToAll(ClientCommand(type: "user.profile.update", ["avatarId": .string(id)]))
    }

    func updateAgent(project: Project, displayName: String, avatar: String, bio: String, provider: Provider?) {
        if let index = snapshot.projects.firstIndex(where: { $0.id == project.id }) {
            snapshot.projects[index].agentProfile.displayName = displayName
            snapshot.projects[index].agentProfile.avatar = avatar
            snapshot.projects[index].agentProfile.bio = bio
            snapshot.projects[index].agentProfile.defaultProvider = provider
            selectedProject = snapshot.projects[index]
            scheduleSnapshotSave()
        }
        _ = sendDurable(ClientCommand(type: "agent.profile.update", [
            "projectId": .string(project.id),
            "displayName": .string(displayName),
            "avatar": .string(avatar),
            "bio": .string(bio),
            "defaultProvider": provider.map { .string($0.rawValue) } ?? .null,
            "idempotencyKey": .string(UUID().uuidString),
        ]))
    }

    func setPinned(sessionId: String, pinned: Bool) {
        updatePreference(sessionId: sessionId) { $0.pinnedAt = pinned ? now() : nil }
        _ = sendDurable(ClientCommand(type: "task.pin", [
            "sessionId": .string(sessionId),
            "pinned": .bool(pinned),
            "idempotencyKey": .string(UUID().uuidString),
        ]))
    }

    // 归档乐观更新 + 6 秒撤销；逆操作（取消归档）同样带幂等键走持久 outbox。
    func setArchived(sessionId: String, archived: Bool, offerUndo: Bool = true) {
        updatePreference(sessionId: sessionId) { $0.archivedAt = archived ? now() : nil }
        _ = sendDurable(ClientCommand(type: "task.archive", [
            "sessionId": .string(sessionId),
            "archived": .bool(archived),
            "idempotencyKey": .string(UUID().uuidString),
        ]))
        if archived {
            Haptics.destructiveLocalAction()
            if offerUndo {
                showNotice("已归档，可在任务列表「已归档」筛选中找回", action: NoticeAction(label: "撤销", perform: { [weak self] in
                    self?.setArchived(sessionId: sessionId, archived: false, offerUndo: false)
                }))
            }
        }
    }

    private func updatePreference(sessionId: String, mutate: (inout TaskPreference) -> Void) {
        var preference = snapshot.taskPreferences.first { $0.sessionId == sessionId }
            ?? TaskPreference(sessionId: sessionId, pinnedAt: nil, archivedAt: nil)
        mutate(&preference)
        upsert(&snapshot.taskPreferences, preference)
        scheduleSnapshotSave()
    }

    private func now() -> String {
        Date.ISO8601FormatStyle(includingFractionalSeconds: true).format(Date())
    }

    func retry(commandId: String) {
        _ = sendDurable(ClientCommand(type: "task.command.retry", [
            "commandId": .string(commandId),
            "idempotencyKey": .string(UUID().uuidString),
        ]))
    }

    // 本地尚未被 Mac 确认的回复，用于 Feed 卡片上立即给出 pending 展示。
    func hasPendingLocalReply(sessionId: String) -> Bool {
        outbox.contains { entry in
            guard ["task.follow_up", "session.message"].contains(entry.command.type),
                  case .string(let id) = entry.command.values["sessionId"], id == sessionId else { return false }
            return !snapshot.commands.contains { $0.idempotencyKey == entry.command.idempotencyKey }
        }
    }

    // 撤回意图先持久化，再移除原指令；即使原指令刚发送但快照尚未到达，
    // 重连后也会先补发 cancel，而不是仅凭快照缺失误判为“本地排队”。
    @discardableResult
    func cancelOutboxEntry(_ entry: OutboxEntry) -> Bool {
        guard CommandCancelRules.isOutboxEntryCancelable(entry, snapshot: snapshot) else { return false }
        let key = entry.command.idempotencyKey ?? entry.id
        let server = snapshot.commands.first(where: {
            $0.idempotencyKey == key || $0.idempotencyKey.hasSuffix(":\(key)")
        })
        let targetKey = server?.idempotencyKey ?? key
        guard sendDurable(ClientCommand(type: "task.command.cancel", [
            "idempotencyKey": .string(targetKey),
        ])) else { return false }
        outbox.removeAll { $0.id == entry.id }
        persistOutbox()
        showNotice("撤回请求已保存，等待 Bridge 确认")
        return true
    }

    // 服务端拒绝后的重试：清掉失败标记立即重发（仍走幂等键，不会重复执行）。
    func retryOutboxEntry(_ entry: OutboxEntry) {
        guard let index = outbox.firstIndex(where: { $0.id == entry.id }) else { return }
        outbox[index].lastError = nil
        persistOutbox()
        _ = bridge.send(routed(entry.command))
        showNotice(bridge.connected ? "已重新发送，等待 Bridge 确认" : "尚未连接 Mac，将在重连后自动发送")
    }

    func removeOutboxEntry(_ entry: OutboxEntry) {
        outbox.removeAll { $0.id == entry.id }
        persistOutbox()
    }

    // 重新编辑：把内容放回对应草稿并移除出队条目，由用户在原输入处修改后重新发送。
    @discardableResult
    func reeditOutboxEntry(_ entry: OutboxEntry) -> Bool {
        switch entry.command.type {
        case "task.create":
            guard case .string(let text) = entry.command.values["text"] else { return false }
            UserDefaults.standard.set(text, forKey: "zimlo.newTaskDraft")
            showingNewTask = true
        case "task.follow_up", "session.message":
            guard case .string(let sessionId) = entry.command.values["sessionId"],
                  case .string(let text) = entry.command.values["text"] else { return false }
            UserDefaults.standard.set(text, forKey: "zimlo.task-draft.\(sessionId)")
            if snapshot.sessions.contains(where: { $0.id == sessionId }) { openTask(sessionId: sessionId) }
        default:
            return false
        }
        outbox.removeAll { $0.id == entry.id }
        persistOutbox()
        return true
    }

    func localFollowUps(session: AgentSession) -> [TaskCommand] {
        outbox.compactMap { entry in
            guard ["task.follow_up", "session.message"].contains(entry.command.type),
                  case .string(let sessionId) = entry.command.values["sessionId"], sessionId == session.id,
                  case .string(let text) = entry.command.values["text"] else { return nil }
            if snapshot.commands.contains(where: { $0.idempotencyKey == entry.command.idempotencyKey }) { return nil }
            return TaskCommand(
                id: "local:\(entry.id)", idempotencyKey: entry.command.idempotencyKey ?? entry.id,
                kind: "follow_up", provider: session.provider, sessionId: session.id,
                workspaceId: nil, cwd: session.cwd ?? "", text: text, state: "queued",
                createdAt: entry.enqueuedAt, updatedAt: entry.enqueuedAt, error: nil
            )
        }
    }

    // 安全解除配对：先在线撤销 Mac/云端推送注册，收到权威确认后再清本机。
    func forgetDevice() {
        guard !isForgettingDevice else { return }
        guard bridge.connected else {
            showNotice("请先重连 Mac，再解除配对并撤销该设备的通知权限。")
            return
        }
        isForgettingDevice = true
        let idempotencyKey = UUID().uuidString
        guard sendDurableToAll(ClientCommand(type: "notification.device.unregister", [
            "idempotencyKey": .string(idempotencyKey),
        ])) else {
            isForgettingDevice = false
            return
        }
        forgetDeviceTask?.cancel()
        forgetDeviceTask = Task { [weak self] in
            // Bridge 的 send 只表示已排队；必须等 notification.device.updated(null)
            // 清掉这条 outbox，才能承诺远端通知注册已撤销。
            for _ in 0..<80 {
                try? await Task.sleep(for: .milliseconds(100))
                guard !Task.isCancelled, let self else { return }
                // sendDurable may deduplicate a retry onto an older semantic
                // entry. Any pending unregister means the authoritative null
                // acknowledgement has not arrived yet, regardless of key.
                let pending = NotificationDeviceRevocationRules.hasPendingUnregister(self.outbox)
                if !pending {
                    self.finishForgettingDevice()
                    return
                }
            }
            guard let self, !Task.isCancelled else { return }
            self.isForgettingDevice = false
            self.showNotice("未能确认通知设备已撤销，请保持 Mac 在线后重试。")
        }
    }

    // 清除本机凭据、快照、outbox、设备级草稿与待处理通知路由；界面偏好保留。
    private func finishForgettingDevice() {
        forgetDeviceTask?.cancel()
        forgetDeviceTask = nil
        NotificationManager.shared.resetRouteKey()
        bridge.forgetDevice()
        hostSnapshots.removeAll()
        snapshot = .empty
        let pendingSave = snapshotSaveTask
        pendingSave?.cancel()
        let writer = snapshotWriter
        // Clear is serialized after any write already executing in the actor.
        // Future saves await this task, so an old snapshot can never reappear
        // after the user explicitly removes the device.
        snapshotClearTask = Task {
            await pendingSave?.value
            await writer.clear()
        }
        snapshotSaveTask = nil
        snapshotSavedAt = nil
        events = [:]
        outbox = []
        persistOutbox()
        selectedSession = nil
        selectedProject = nil
        clearPendingRoute()
        clearNotice()
        isForgettingDevice = false
        let defaults = UserDefaults.standard
        for key in defaults.dictionaryRepresentation().keys {
            if key.hasPrefix("zimlo.task-draft.")
                || key.hasPrefix("zimlo.feed-reply.")
                || key.hasPrefix("zimlo.action-draft.")
                || key == "zimlo.newTaskDraft" {
                defaults.removeObject(forKey: key)
            }
        }
    }

    func forgetHost(_ hostId: String) {
        let removedSessionIds = Set(hostSnapshots[hostId]?.sessions.map(\.id) ?? snapshot.sessions.filter { $0.hostId == hostId }.map(\.id))
        bridge.forgetHost(hostId)
        hostSnapshots.removeValue(forKey: hostId)
        outbox.removeAll { $0.command.values["hostId"]?.stringValue == hostId }
        persistOutbox()
        snapshot = mergeHostSnapshots()
        events = events.filter { !removedSessionIds.contains($0.key) }
        if let selectedSession, removedSessionIds.contains(selectedSession.id) { self.selectedSession = nil }
        if selectedProject?.hostId == hostId { selectedProject = nil }
        if bridge.hosts.isEmpty {
            snapshot = .empty
            events = [:]
            selectedSession = nil
            selectedProject = nil
        }
        scheduleSnapshotSave(after: .zero)
        showNotice("已移除这台 Mac")
    }

    func send(_ command: ClientCommand) -> Bool {
        if bridge.send(routed(command)) { return true }
        showNotice("Bridge 尚未连接，请稍后重试")
        return false
    }

    @discardableResult
    private func sendDurable(_ input: ClientCommand) -> Bool {
        let command = routed(input)
        let key = SemanticKey.make(command)
        // 状态覆盖类指令：同一语义键只保留最新一条；feed.dismiss.set 同理（最新状态胜出）。
        let replaceable = ["user.profile.update", "agent.profile.update", "trust.policy.update",
                           "notification.settings.update", "notification.device.register", "feed.dismiss.set"]
        if let index = outbox.firstIndex(where: { $0.semanticKey == key }) {
            if replaceable.contains(command.type) {
                outbox[index].command = command
                outbox[index].enqueuedAt = now()
                outbox[index].lastError = nil
                guard persistOutbox() else { return false }
                _ = bridge.send(command)
                return true
            }
            if let notice = OutboxFeedbackRules.duplicateNotice(commandType: command.type) {
                showNotice(notice)
            }
            return bridge.send(outbox[index].command) || true
        }
        let hostId = command.values["hostId"]?.stringValue ?? "unscoped"
        let entry = OutboxEntry(
            id: command.type == "task.command.cancel" ? key : "\(hostId):\(command.idempotencyKey ?? UUID().uuidString)",
            semanticKey: key,
            command: command,
            enqueuedAt: now(),
            lastError: nil
        )
        outbox.append(entry)
        guard persistOutbox() else {
            outbox.removeAll { $0.id == entry.id }
            showNotice("无法保存到本机队列，请重试")
            return false
        }
        let sent = bridge.send(command)
        if OutboxFeedbackRules.userAuthoredTypes.contains(command.type) { Haptics.persisted() }
        if let notice = OutboxFeedbackRules.queuedNotice(commandType: command.type, sent: sent) {
            showNotice(notice)
        }
        return true
    }

    @discardableResult
    private func sendDurableToAll(_ input: ClientCommand) -> Bool {
        let hostIds = bridge.hosts.map(\.id)
        guard !hostIds.isEmpty else { return sendDurable(input) }
        var persisted = true
        for hostId in hostIds {
            var command = input
            command.values["hostId"] = .string(hostId)
            persisted = sendDurable(command) && persisted
        }
        return persisted
    }

    func uploadAndRegister(_ prepared: PreparedMobileMaterial, hostId: String? = nil) async throws -> Material {
        let targetHostId = hostId ?? routed(ClientCommand(type: "material.register")).values["hostId"]?.stringValue
        let transport = try await bridge.uploadMaterial(prepared, hostId: targetHostId)
        var material: [String: JSONValue] = [
            "id": .string(prepared.material.id), "kind": .string(prepared.material.kind),
            "name": .string(prepared.material.name), "mimeType": .string(prepared.material.mimeType),
            "sizeBytes": .number(Double(prepared.material.sizeBytes)), "sha256": .string(prepared.material.sha256),
            "origin": .string(prepared.material.origin), "createdAt": .string(prepared.material.createdAt),
        ]
        if let width = prepared.material.width { material["width"] = .number(Double(width)) }
        if let height = prepared.material.height { material["height"] = .number(Double(height)) }
        if let duration = prepared.material.durationMs { material["durationMs"] = .number(Double(duration)) }
        if let targetHostId {
            material["hostId"] = .string(targetHostId)
        }
        let persisted = sendDurable(ClientCommand(type: "material.register", [
            "material": .object(material), "transport": .string(transport),
            "encryptionKey": .string(prepared.encryptionKey), "idempotencyKey": .string(UUID().uuidString),
            "hostId": targetHostId.map(JSONValue.string) ?? .null,
        ]))
        guard persisted else { throw MaterialError.message("无法保存物料队列，请重试") }
        var result = prepared.material
        result.hostId = targetHostId
        return result
    }

    func localURL(for material: Material) async throws -> URL {
        try await bridge.downloadMaterial(material)
    }

    @discardableResult
    private func persistOutbox() -> Bool {
        guard let data = try? JSONEncoder().encode(outbox) else { return false }
        UserDefaults.standard.set(data, forKey: outboxKey)
        return true
    }

    private func flushOutbox(hostId: String? = nil) {
        guard bridge.connected, !outbox.isEmpty else { return }
        for entry in outbox where entry.lastError == nil
            && (hostId == nil || entry.command.values["hostId"]?.stringValue == hostId) {
            _ = bridge.send(entry.command)
        }
    }

    private func acknowledge(_ message: ServerEnvelope, hostId: String) {
        let previousCount = outbox.count
        outbox.removeAll { entry in
            if let commandHostId = entry.command.values["hostId"]?.stringValue, commandHostId != hostId { return false }
            switch message.type {
            case "task.command.updated":
                guard let command = message.command else { return false }
                if entry.command.type == "task.command.cancel" { return false }
                if entry.command.type == "task.command.retry",
                   case .string(let commandId) = entry.command.values["commandId"] {
                    return command.id == commandId
                }
                return entry.command.idempotencyKey == command.idempotencyKey
                    || command.idempotencyKey.hasSuffix(":\(entry.command.idempotencyKey ?? "")")
            case "material.updated":
                guard entry.command.type == "material.register", let material = message.material,
                      case .object(let value) = entry.command.values["material"],
                      case .string(let id) = value["id"] else { return false }
                return id == material.id
            case "task.command.cancel.result":
                guard entry.command.type == "task.command.cancel" else { return false }
                if case .string(let commandId) = entry.command.values["commandId"] {
                    return commandId == message.commandId
                }
                if case .string(let key) = entry.command.values["idempotencyKey"] {
                    return key == message.idempotencyKey
                }
                return false
            case "feed.dismissed.updated":
                guard case .string(let itemId) = entry.command.values["itemId"] else { return false }
                // dismissed=false 用权威 session.snapshot 确认，不能被旧式增量事件误清。
                return ["feed.dismiss", "feed.dismiss.set"].contains(entry.command.type)
                    && entry.command.values["dismissed"] != .bool(false)
                    && itemId == message.itemId
            case "session.snapshot":
                guard let snapshot = message.snapshot else { return false }
                return FeedDismissAcknowledgementRules.snapshotConfirmsUndo(entry, snapshot: snapshot)
            case "feed.seen.updated":
                guard case .string(let postId) = entry.command.values["postId"] else { return false }
                return entry.command.type == "feed.seen" && postId == message.postId
            case "task.timeline.seen.updated":
                guard case .string(let sessionId) = entry.command.values["sessionId"],
                      case .string(let itemId) = entry.command.values["itemId"] else { return false }
                return entry.command.type == "task.timeline.seen"
                    && sessionId == message.sessionId && itemId == message.itemId
            case "user.profile.updated":
                return entry.command.type == "user.profile.update"
            case "project.updated":
                guard let project = message.project,
                      case .string(let projectId) = entry.command.values["projectId"] else { return false }
                return entry.command.type == "agent.profile.update" && project.id == projectId
            case "trust.policy.updated":
                guard let policy = message.policy, case .string(let projectId) = entry.command.values["projectId"] else { return false }
                return entry.command.type == "trust.policy.update" && policy.projectId == projectId
            case "notification.settings.updated":
                return entry.command.type == "notification.settings.update"
            case "notification.device.updated":
                return NotificationDeviceAcknowledgementRules.confirms(entry, registration: message.registration)
            case "action.result":
                guard case .string(let actionId) = entry.command.values["actionId"] else { return false }
                return entry.command.type == "action.decide" && actionId == message.actionId
            default: return false
            }
        }
        if outbox.count != previousCount { persistOutbox() }
    }

    private func apply(_ incoming: ServerEnvelope, hostId: String) {
        var message = incoming
        if var project = message.project { project.hostId = hostId; message.project = project }
        if var session = message.session { session.hostId = hostId; message.session = session }
        if var post = message.post { post.hostId = hostId; message.post = post }
        if var task = message.task { task.hostId = hostId; message.task = task }
        if var command = message.command { command.hostId = hostId; message.command = command }
        if var material = message.material { material.hostId = hostId; message.material = material }
        if var action = message.action { action.hostId = hostId; message.action = action }
        if var preference = message.preference { preference.hostId = hostId; message.preference = preference }
        if var policy = message.policy { policy.hostId = hostId; message.policy = policy }
        if let policies = message.policies {
            message.policies = policies.map { item in var item = item; item.hostId = hostId; return item }
        }
        if let audit = message.audit {
            message.audit = audit.map { item in var item = item; item.hostId = hostId; return item }
        }
        var snapshotChanged = false
        var shouldRefreshSnapshotCache = false
        // 审批的服务端确认在 acknowledge 之前判定：确认成功才播成功触觉（本地操作不播）。
        var approvalConfirmed = false
        if message.type == "action.result", message.ok == true, let actionId = message.actionId {
            approvalConfirmed = outbox.contains {
                $0.command.type == "action.decide" && $0.command.values["actionId"] == .string(actionId)
            }
        }
        acknowledge(message, hostId: hostId)
        if approvalConfirmed { Haptics.serverConfirmed() }
        switch message.type {
        case "session.snapshot":
            if var snapshot = message.snapshot {
                snapshot = scoped(snapshot, hostId: hostId)
                hostSnapshots[hostId] = snapshot
                snapshot = mergeHostSnapshots()
                // A full snapshot is a successful sync boundary. Persist it
                // even when its contents are unchanged so offline freshness
                // reflects the last verified connection, not the last mutation.
                shouldRefreshSnapshotCache = true
                if snapshot != self.snapshot {
                    self.snapshot = snapshot
                    snapshotChanged = true
                }
                if let sessionId = pendingRouteSessionId,
                   snapshot.sessions.contains(where: { $0.id == sessionId }) {
                    openTask(sessionId: sessionId)
                }
            }
        case "user.profile.updated":
            if let profile = message.userProfile { snapshot.userProfile = profile; snapshotChanged = true }
        case "project.updated":
            if let project = message.project { upsert(&snapshot.projects, project); snapshotChanged = true }
        case "session.updated":
            if let session = message.session {
                upsert(&snapshot.sessions, session)
                if selectedSession?.id == session.id { selectedSession = session }
                snapshotChanged = true
            }
        case "session.removed":
            let previousCount = snapshot.sessions.count
            snapshot.sessions.removeAll { $0.id == message.sessionId }
            snapshotChanged = snapshot.sessions.count != previousCount
        case "feed.posted":
            if let post = message.post { upsert(&snapshot.posts, post); snapshotChanged = true }
        case "task.updated":
            if let task = message.task { upsert(&snapshot.tasks, task); snapshotChanged = true }
        case "task.command.updated":
            if let command = message.command { upsert(&snapshot.commands, command); snapshotChanged = true }
        case "material.updated":
            if let material = message.material { upsert(&snapshot.materials, material); snapshotChanged = true }
        case "task.command.cancel.result":
            showNotice(message.message ?? (message.ok == false ? "指令无法撤回" : "指令已撤回"))
        case "feed.seen.updated":
            if let postId = message.postId, !snapshot.seenPostIds.contains(postId) {
                snapshot.seenPostIds.append(postId); snapshotChanged = true
            }
        case "feed.dismissed.updated":
            if let itemId = message.itemId, !snapshot.dismissedFeedItemIds.contains(itemId) {
                snapshot.dismissedFeedItemIds.append(itemId); snapshotChanged = true
            }
        case "task.timeline.seen.updated":
            if let sessionId = message.sessionId, let itemId = message.itemId {
                snapshot.taskTimelineCursors[sessionId] = itemId; snapshotChanged = true
            }
        case "task.preference.updated":
            if let preference = message.preference { upsert(&snapshot.taskPreferences, preference); snapshotChanged = true }
        case "trust.policy.updated":
            if let policy = message.policy { upsert(&snapshot.trustPolicies, policy); snapshotChanged = true }
        case "trust.policies":
            if let policies = message.policies { snapshot.trustPolicies = policies; snapshotChanged = true }
            if let audit = message.audit { snapshot.trustAudit = audit; snapshotChanged = true }
        case "notification.settings.updated":
            if let settings = message.settings { snapshot.notificationSettings = settings; snapshotChanged = true }
        case "notification.device.updated":
            snapshot.pushDevices = message.registration.map { [$0] } ?? []
            snapshotChanged = true
        case "action.upsert":
            if let action = message.action { upsert(&snapshot.actions, action); snapshotChanged = true }
        case "session.events":
            if let sessionId = message.sessionId, let events = message.events {
                self.events[sessionId] = EventBufferRules.bounded(events)
            }
        case "event.upsert":
            if let event = message.event {
                var sessionEvents = events[event.sessionId] ?? []
                if let index = sessionEvents.firstIndex(where: { $0.id == event.id }) { sessionEvents[index] = event }
                else { sessionEvents.append(event) }
                events[event.sessionId] = EventBufferRules.bounded(sessionEvents)
            }
        case "action.result":
            showNotice(message.message ?? (message.ok == false ? "审批未被接受" : "审批已确认"))
        case "session.message.result":
            showNotice(message.message ?? "指令未被接受")
            if message.ok == false, let sessionId = message.sessionId {
                markOutboxFailed(message.message ?? "服务端拒绝") {
                    ["task.follow_up", "session.message"].contains($0.command.type)
                        && $0.command.values["hostId"] == .string(hostId)
                        && $0.command.values["sessionId"] == .string(sessionId)
                }
            }
        case "error":
            let error = message.message ?? "Bridge 返回错误"
            if markOutboxFailed(
                code: message.code,
                error: error,
                idempotencyKey: message.idempotencyKey,
                hostId: hostId
            ) {
                showNotice("手机操作同步失败：\(error)", action: NoticeAction(label: "查看") {
                    self.showingOutbox = true
                })
            } else {
                showNotice(error)
            }
        default:
            break
        }
        if snapshotChanged, message.type != "session.snapshot" {
            captureHostIncrementalState(hostId: hostId, messageType: message.type)
            snapshot = mergeHostSnapshots()
        }
        if snapshotChanged || shouldRefreshSnapshotCache { scheduleSnapshotSave() }
    }

    private func captureHostIncrementalState(hostId: String, messageType: String) {
        var local = hostSnapshots[hostId] ?? scoped(.empty, hostId: hostId)
        local.host = local.host ?? bridge.hosts.first(where: { $0.id == hostId })?.host
        local.projects = snapshot.projects.filter { $0.hostId == hostId }
        local.sessions = snapshot.sessions.filter { $0.hostId == hostId }
        local.posts = snapshot.posts.filter { $0.hostId == hostId }
        local.tasks = snapshot.tasks.filter { $0.hostId == hostId }
        local.commands = snapshot.commands.filter { $0.hostId == hostId }
        local.materials = snapshot.materials.filter { $0.hostId == hostId }
        local.workspaces = snapshot.workspaces.filter { $0.hostId == hostId }
        local.actions = snapshot.actions.filter { $0.hostId == hostId }
        let sessionIds = Set(local.sessions.map(\.id))
        local.taskPreferences = snapshot.taskPreferences.filter { $0.hostId == hostId }
        local.trustPolicies = snapshot.trustPolicies.filter { $0.hostId == hostId }
        local.trustAudit = snapshot.trustAudit.filter { $0.hostId == hostId }
        local.seenPostIds = snapshot.seenPostIds
        local.dismissedFeedItemIds = snapshot.dismissedFeedItemIds
        local.taskTimelineCursors = snapshot.taskTimelineCursors.filter { sessionIds.contains($0.key) }
        if messageType == "user.profile.updated" { local.userProfile = snapshot.userProfile }
        if messageType == "notification.settings.updated" { local.notificationSettings = snapshot.notificationSettings }
        if messageType == "notification.device.updated" { local.pushDevices = snapshot.pushDevices }
        if messageType == "lan.approvals.changed" { local.lanApprovalsEnabled = snapshot.lanApprovalsEnabled }
        hostSnapshots[hostId] = local
    }

    private func scoped(_ value: Snapshot, hostId: String) -> Snapshot {
        var value = value
        value.host = value.host ?? bridge.hosts.first(where: { $0.id == hostId })?.host
        value.projects = value.projects.map { item in var item = item; item.hostId = hostId; return item }
        value.sessions = value.sessions.map { item in var item = item; item.hostId = hostId; return item }
        value.posts = value.posts.map { item in var item = item; item.hostId = hostId; return item }
        value.tasks = value.tasks.map { item in var item = item; item.hostId = hostId; return item }
        value.commands = value.commands.map { item in var item = item; item.hostId = hostId; return item }
        value.materials = value.materials.map { item in var item = item; item.hostId = hostId; return item }
        value.workspaces = value.workspaces.map { item in var item = item; item.hostId = hostId; return item }
        value.actions = value.actions.map { item in var item = item; item.hostId = hostId; return item }
        value.taskPreferences = value.taskPreferences.map { item in var item = item; item.hostId = hostId; return item }
        value.trustPolicies = value.trustPolicies.map { item in var item = item; item.hostId = hostId; return item }
        value.trustAudit = value.trustAudit.map { item in var item = item; item.hostId = hostId; return item }
        return value
    }

    private func mergeHostSnapshots() -> Snapshot {
        let values = hostSnapshots.values.sorted {
            ($0.host?.lastSeenAt ?? "") > ($1.host?.lastSeenAt ?? "")
        }
        guard let primary = values.first else { return snapshot }
        let newestProfile = values.max { $0.userProfile.updatedAt < $1.userProfile.updatedAt }?.userProfile ?? primary.userProfile
        let newestNotifications = values.max { $0.notificationSettings.updatedAt < $1.notificationSettings.updatedAt }?.notificationSettings ?? primary.notificationSettings
        func unique(_ values: [String]) -> [String] { Array(Set(values)).sorted() }
        let cursors = values.reduce(into: [String: String]()) { result, value in
            result.merge(value.taskTimelineCursors) { _, incoming in incoming }
        }
        return Snapshot(
            host: primary.host,
            userProfile: newestProfile,
            projects: values.flatMap(\.projects),
            sessions: values.flatMap(\.sessions),
            posts: values.flatMap(\.posts).sorted { $0.createdAt > $1.createdAt },
            tasks: values.flatMap(\.tasks),
            commands: values.flatMap(\.commands),
            materials: values.flatMap(\.materials),
            workspaces: values.flatMap(\.workspaces),
            seenPostIds: unique(values.flatMap(\.seenPostIds)),
            dismissedFeedItemIds: unique(values.flatMap(\.dismissedFeedItemIds)),
            taskTimelineCursors: cursors,
            taskPreferences: values.flatMap(\.taskPreferences),
            actions: values.flatMap(\.actions),
            trustPolicies: values.flatMap(\.trustPolicies),
            trustAudit: values.flatMap(\.trustAudit),
            notificationSettings: newestNotifications,
            pushDevices: values.flatMap(\.pushDevices),
            features: FeatureCapabilities(
                projectTrustPolicy: values.contains { $0.features.projectTrustPolicy },
                pushNotifications: values.contains { $0.features.pushNotifications },
                remoteSync: values.contains { $0.features.remoteSync },
                multiHost: true
            ),
            sequence: values.map(\.sequence).max() ?? 0,
            lanApprovalsEnabled: values.contains { $0.lanApprovalsEnabled },
            trustManagementEnabled: values.contains { $0.trustManagementEnabled }
        )
    }

    private func routed(_ input: ClientCommand) -> ClientCommand {
        if case .string = input.values["hostId"] { return input }
        func string(_ key: String) -> String? {
            guard case .string(let value) = input.values[key] else { return nil }
            return value
        }
        var hostId: String?
        if let sessionId = string("sessionId") {
            hostId = snapshot.sessions.first(where: { $0.id == sessionId })?.hostId
        } else if let projectId = string("projectId") {
            hostId = snapshot.projects.first(where: { $0.id == projectId })?.hostId
        } else if let workspaceId = string("workspaceId") {
            hostId = snapshot.workspaces.first(where: { $0.id == workspaceId })?.hostId
        } else if let postId = string("postId") {
            hostId = snapshot.posts.first(where: { $0.id == postId })?.hostId
        } else if let actionId = string("actionId") {
            hostId = snapshot.actions.first(where: { $0.actionId == actionId })?.hostId
        } else if let itemId = string("itemId") {
            if itemId.hasPrefix("post:") {
                hostId = snapshot.posts.first(where: { $0.id == String(itemId.dropFirst(5)) })?.hostId
            } else if itemId.hasPrefix("action:") {
                hostId = snapshot.actions.first(where: { $0.actionId == String(itemId.dropFirst(7)) })?.hostId
            }
        }
        hostId = hostId ?? bridge.hosts.first(where: { $0.connected })?.id ?? bridge.hosts.first?.id
        guard let hostId else { return input }
        var output = input
        output.values["hostId"] = .string(hostId)
        return output
    }

    /// Coalesces message bursts, then moves JSON encoding and atomic disk IO
    /// off MainActor. The writer actor guarantees an older snapshot cannot win
    /// a race and overwrite a newer one.
    private func scheduleSnapshotSave(after delay: Duration = .milliseconds(350)) {
        snapshotSaveTask?.cancel()
        let value = snapshot
        let writer = snapshotWriter
        let pendingClear = snapshotClearTask
        snapshotSaveTask = Task { [weak self] in
            if delay != .zero { try? await Task.sleep(for: delay) }
            guard !Task.isCancelled else { return }
            await pendingClear?.value
            guard !Task.isCancelled else { return }
            let savedAt = await writer.save(value)
            guard !Task.isCancelled, let savedAt else { return }
            self?.snapshotSavedAt = savedAt
        }
    }

    private func flushSnapshotForBackground() {
        guard !bridge.pairingRequired else { return }
        let pendingSave = snapshotSaveTask
        pendingSave?.cancel()
        let pendingClear = snapshotClearTask
        let value = snapshot
        let writer = snapshotWriter
        var backgroundTask = UIBackgroundTaskIdentifier.invalid
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "snapshot-cache") {
            if backgroundTask != .invalid {
                UIApplication.shared.endBackgroundTask(backgroundTask)
                backgroundTask = .invalid
            }
        }
        snapshotSaveTask = Task { [weak self] in
            await pendingSave?.value
            await pendingClear?.value
            let savedAt = await writer.save(value)
            if let savedAt { self?.snapshotSavedAt = savedAt }
            if backgroundTask != .invalid {
                UIApplication.shared.endBackgroundTask(backgroundTask)
                backgroundTask = .invalid
            }
        }
    }

    // 服务端拒绝：标失败（不静默恢复、不重复发送），outbox 详情里提供重试/重新编辑。
    private func markOutboxFailed(_ error: String, matching: (OutboxEntry) -> Bool) {
        var changed = false
        for index in outbox.indices where matching(outbox[index]) {
            outbox[index].lastError = error
            changed = true
        }
        if changed { persistOutbox() }
    }

    // 通用 Bridge error 通过幂等键精确关联；旧 Bridge 的 project_not_found 仅在
    // 单一无效目标时安全回退。失败项保留供用户查看/重试/移除，但自动重发会跳过。
    @discardableResult
    func markOutboxFailed(
        code: String?,
        error: String,
        idempotencyKey: String?,
        hostId: String
    ) -> Bool {
        let ids = OutboxFailureRules.matchingEntryIDs(
            entries: outbox,
            code: code,
            idempotencyKey: idempotencyKey,
            hostId: hostId,
            snapshot: snapshot
        )
        guard !ids.isEmpty else { return false }
        var changed = false
        for index in outbox.indices where ids.contains(outbox[index].id) {
            if outbox[index].lastError != error {
                outbox[index].lastError = error
                changed = true
            }
        }
        if changed { persistOutbox() }
        return true
    }

    private func upsert<T: Identifiable>(_ values: inout [T], _ value: T) where T.ID: Equatable {
        if let index = values.firstIndex(where: { $0.id == value.id }) { values[index] = value }
        else { values.insert(value, at: 0) }
    }
}
