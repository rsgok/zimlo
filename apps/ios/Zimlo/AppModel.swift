import Combine
import Foundation
import SwiftUI
import UserNotifications

enum MainTab: String, CaseIterable {
    case feed
    case tasks
    case create
    case agents
    case settings
}

struct FeedEntry: Identifiable, Hashable {
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

@MainActor
final class AppModel: ObservableObject {
    let bridge = BridgeClient()

    @Published var snapshot = SnapshotCache.load() ?? .empty
    @Published var events: [String: [UnifiedEvent]] = [:]
    @Published var selectedTab: MainTab = .feed
    @Published var selectedSession: AgentSession?
    @Published var selectedProject: Project?
    @Published var showingNewTask = false
    @Published var newTaskProjectId: String?
    @Published var notice: String?
    @Published var notificationPermission = "正在检查"

    private var bridgeObserver: AnyCancellable?
    private var outbox: [OutboxEntry] = []
    private let outboxKey = "zimlo.native.command-outbox.v1"

    init() {
        outbox = (try? JSONDecoder().decode(
            [OutboxEntry].self,
            from: UserDefaults.standard.data(forKey: outboxKey) ?? Data()
        )) ?? []
        bridgeObserver = bridge.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
        bridge.onMessage = { [weak self] message in self?.apply(message) }
        NotificationManager.shared.onRegistration = { [weak self] token, publicKey in
            guard let self else { return }
            #if DEBUG
            let environment = "development"
            #else
            let environment = "production"
            #endif
            _ = self.sendDurable(ClientCommand(type: "notification.device.register", [
                "token": .string(token),
                "publicKey": .string(publicKey),
                "environment": .string(environment),
                "idempotencyKey": .string(UUID().uuidString),
            ]))
        }
        NotificationManager.shared.onRoute = { [weak self] sessionId in
            guard let self else { return }
            if self.snapshot.sessions.contains(where: { $0.id == sessionId }) {
                self.openTask(sessionId: sessionId)
            } else {
                UserDefaults.standard.set(sessionId, forKey: "zimlo.pending-push-route")
                self.notice = "任务状态将在连接 Mac 后打开"
            }
        }
        NotificationManager.shared.onError = { [weak self] message in self?.notice = message }
        Task { [weak self] in
            let status = await NotificationManager.shared.authorizationStatus()
            self?.notificationPermission = Self.notificationPermissionLabel(status)
        }
        bridge.onSecureConnection = { [weak self] in
            guard let self else { return }
            for entry in self.outbox { _ = self.bridge.send(entry.command) }
            _ = self.bridge.send(ClientCommand(type: "snapshot.request", [
                "afterSequence": .number(Double(self.snapshot.sequence)),
            ]))
            if let sessionId = self.selectedSession?.id {
                _ = self.bridge.send(ClientCommand(type: "session.events.request", ["sessionId": .string(sessionId)]))
            }
        }
    }

    var pendingOutboxCount: Int { outbox.count }

    var feedEntries: [FeedEntry] {
        let dismissed = Set(snapshot.dismissedFeedItemIds)
        let seen = Set(snapshot.seenPostIds)
        let pendingActionIds = Set(snapshot.actions.filter { $0.state == "pending" }.map(\.actionId))
        let linkedActionIds = Set(snapshot.posts.flatMap(\.pendingActionIds))
        let taskById = Dictionary(uniqueKeysWithValues: snapshot.tasks.map { ($0.id, $0) })
        let reviewByPostId = Dictionary(uniqueKeysWithValues: snapshot.reviews.map { ($0.postId, $0) })
        var taskBySession: [String: TaskRecord] = [:]
        for task in snapshot.tasks {
            guard let sessionId = task.sessionId else { continue }
            if task.updatedAt > (taskBySession[sessionId]?.updatedAt ?? "") { taskBySession[sessionId] = task }
        }

        var entries = mergedPosts(snapshot.posts).map { post -> FeedEntry in
            let task = taskById[post.taskId] ?? post.sessionId.flatMap { taskBySession[$0] }
            let review = reviewByPostId[post.id]
            let settledReview = review != nil && review?.state != "unreviewed"
            let linkedPending = post.pendingActionIds.contains(where: pendingActionIds.contains)
            let directReply = post.pendingActionIds.isEmpty
                && (task == nil || ["waiting_input", "user_review"].contains(task?.state ?? ""))
            let needsAction = review?.state == "unreviewed"
                || (post.actionRequired && (linkedPending || directReply))
            let unread = !settledReview && !seen.contains(post.id)
            let kindPriority = ["failure": 1, "result": 2, "decision": 3, "attention": 3, "progress": 4][post.kind] ?? 5
            return FeedEntry(
                id: "post:\(post.id)", createdAt: post.createdAt, needsAction: needsAction,
                unread: unread, settledReview: settledReview,
                priority: needsAction ? 0 : kindPriority + (unread ? 0 : 10),
                sessionId: post.sessionId, content: .post(post)
            )
        }
        entries += snapshot.actions
            .filter { $0.state == "pending" && !linkedActionIds.contains($0.actionId) }
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
        return entries
            .filter { !dismissed.contains($0.id) }
            .sorted {
                if $0.priority != $1.priority { return $0.priority < $1.priority }
                return $0.createdAt > $1.createdAt
            }
    }

    private func mergedPosts(_ posts: [FeedPost]) -> [FeedPost] {
        var merged: [FeedPost] = []
        var latestIndex: [String: Int] = [:]
        for post in posts.sorted(by: { $0.createdAt > $1.createdAt }) {
            guard ["progress", "decision"].contains(post.kind) else {
                merged.append(post)
                continue
            }
            let key = "\(post.sessionId ?? post.taskId):\(post.kind)"
            if let index = latestIndex[key],
               merged[index].createdAt.zimloDate.timeIntervalSince(post.createdAt.zimloDate) <= 6 * 60 * 60 {
                let facts = merged[index].highlights + post.highlights
                merged[index].highlights = Array(NSOrderedSet(array: facts).compactMap { $0 as? String }.prefix(2))
            } else {
                latestIndex[key] = merged.count
                merged.append(post)
            }
        }
        return merged
    }

    func start() { bridge.start() }
    func stop() { bridge.stop() }

    func openTask(sessionId: String) {
        guard let session = snapshot.sessions.first(where: { $0.id == sessionId }) else { return }
        selectedSession = session
        _ = send(ClientCommand(type: "session.events.request", ["sessionId": .string(sessionId)]))
    }

    func openAgent(projectId: String) {
        selectedProject = snapshot.projects.first(where: { $0.id == projectId })
    }

    func markSeen(_ postId: String) {
        guard !snapshot.seenPostIds.contains(postId) else { return }
        snapshot.seenPostIds.append(postId)
        _ = sendDurable(ClientCommand(type: "feed.seen", ["postId": .string(postId)]))
    }

    func markTimelineSeen(sessionId: String, itemId: String) {
        snapshot.taskTimelineCursors[sessionId] = itemId
        _ = sendDurable(ClientCommand(type: "task.timeline.seen", [
            "sessionId": .string(sessionId),
            "itemId": .string(itemId),
        ]))
    }

    func dismiss(_ itemId: String) {
        if !snapshot.dismissedFeedItemIds.contains(itemId) { snapshot.dismissedFeedItemIds.append(itemId) }
        _ = sendDurable(ClientCommand(type: "feed.dismiss", ["itemId": .string(itemId)]))
    }

    func createTask(provider: Provider, workspaceId: String, text: String) {
        let command = ClientCommand(type: "task.create", [
            "provider": .string(provider.rawValue),
            "workspaceId": .string(workspaceId),
            "text": .string(text),
            "idempotencyKey": .string(UUID().uuidString),
        ])
        _ = sendDurable(command)
        selectedTab = .feed
        showingNewTask = false
    }

    func followUp(sessionId: String, text: String) {
        _ = sendDurable(ClientCommand(type: "task.follow_up", [
            "sessionId": .string(sessionId),
            "text": .string(text),
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

    func respondReview(_ review: TaskReview, decision: String, note: String? = nil) {
        var values: [String: JSONValue] = [
            "reviewId": .string(review.id),
            "decision": .string(decision),
            "idempotencyKey": .string(UUID().uuidString),
        ]
        if let note, !note.isEmpty { values["note"] = .string(note) }
        _ = sendDurable(ClientCommand(type: "review.respond", values))
    }

    func updateTrustPolicy(projectId: String, preset: String) {
        _ = sendDurable(ClientCommand(type: "trust.policy.update", [
            "projectId": .string(projectId),
            "preset": .string(preset),
            "idempotencyKey": .string(UUID().uuidString),
        ]))
    }

    func updateNotificationSettings(_ settings: NotificationSettings) {
        _ = sendDurable(ClientCommand(type: "notification.settings.update", [
            "settings": .object([
                "enabled": .bool(settings.enabled),
                "approvals": .bool(settings.approvals),
                "failures": .bool(settings.failures),
                "reviews": .bool(settings.reviews),
                "showTaskTitle": .bool(settings.showTaskTitle),
            ]),
            "idempotencyKey": .string(UUID().uuidString),
        ]))
    }

    func requestNotifications() {
        Task {
            let allowed = await NotificationManager.shared.requestAuthorization()
            notificationPermission = allowed ? "系统已允许" : "系统未允许"
            var settings = snapshot.notificationSettings
            settings.enabled = allowed
            updateNotificationSettings(settings)
            if !allowed { notice = "通知未开启，可稍后在系统设置中允许。" }
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

    func submitInput(action: PendingAction, answer: String) {
        _ = sendDurable(ClientCommand(type: "action.decide", [
            "actionId": .string(action.actionId),
            "sessionId": .string(action.sessionId),
            "decisionId": .string("submit-input"),
            "idempotencyKey": .string(UUID().uuidString),
            "input": .object(["answer": .string(answer)]),
        ]))
    }

    func updateAvatar(_ id: String) {
        snapshot.userProfile.avatarId = id
        _ = sendDurable(ClientCommand(type: "user.profile.update", ["avatarId": .string(id)]))
    }

    func updateAgent(project: Project, displayName: String, avatar: String, bio: String, provider: Provider?) {
        if let index = snapshot.projects.firstIndex(where: { $0.id == project.id }) {
            snapshot.projects[index].agentProfile.displayName = displayName
            snapshot.projects[index].agentProfile.avatar = avatar
            snapshot.projects[index].agentProfile.bio = bio
            snapshot.projects[index].agentProfile.defaultProvider = provider
            selectedProject = snapshot.projects[index]
        }
        _ = sendDurable(ClientCommand(type: "agent.profile.update", [
            "projectId": .string(project.id),
            "displayName": .string(displayName),
            "avatar": .string(avatar),
            "bio": .string(bio),
            "defaultProvider": provider.map { .string($0.rawValue) } ?? .null,
        ]))
    }

    func setPinned(sessionId: String, pinned: Bool) {
        _ = send(ClientCommand(type: "task.pin", ["sessionId": .string(sessionId), "pinned": .bool(pinned)]))
    }

    func setArchived(sessionId: String, archived: Bool) {
        _ = send(ClientCommand(type: "task.archive", ["sessionId": .string(sessionId), "archived": .bool(archived)]))
    }

    func retry(commandId: String) {
        _ = sendDurable(ClientCommand(type: "task.command.retry", [
            "commandId": .string(commandId),
            "idempotencyKey": .string(UUID().uuidString),
        ]))
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

    func forgetDevice() {
        bridge.forgetDevice()
        snapshot = .empty
        SnapshotCache.clear()
        events = [:]
    }

    func send(_ command: ClientCommand) -> Bool {
        if bridge.send(command) { return true }
        notice = "Bridge 尚未连接，请稍后重试"
        return false
    }

    @discardableResult
    private func sendDurable(_ command: ClientCommand) -> Bool {
        let key = semanticKey(command)
        if let index = outbox.firstIndex(where: { $0.semanticKey == key }) {
            let existing = outbox[index]
            if ["user.profile.update", "agent.profile.update", "trust.policy.update", "notification.settings.update", "notification.device.register"].contains(command.type) {
                outbox[index].command = command
                outbox[index].enqueuedAt = ISO8601DateFormatter.zimlo.string(from: Date())
                persistOutbox()
                _ = bridge.send(command)
                notice = "设置已更新，等待 Bridge 确认"
                return true
            }
            notice = "这条指令已在队列中，不会重复发送"
            return bridge.send(existing.command) || true
        }
        let now = ISO8601DateFormatter.zimlo.string(from: Date())
        let entry = OutboxEntry(
            id: command.idempotencyKey ?? UUID().uuidString,
            semanticKey: key,
            command: command,
            enqueuedAt: now
        )
        outbox.append(entry)
        persistOutbox()
        let sent = bridge.send(command)
        notice = sent ? "指令已发送，等待 Bridge 确认" : "指令已保存在手机，将在重连后自动发送"
        objectWillChange.send()
        return true
    }

    private func semanticKey(_ command: ClientCommand) -> String {
        func string(_ key: String) -> String {
            if case .string(let value) = command.values[key] { return value.trimmingCharacters(in: .whitespacesAndNewlines) }
            return ""
        }
        switch command.type {
        case "task.create": return "\(command.type):\(string("provider")):\(string("workspaceId")):\(string("text"))"
        case "task.follow_up", "session.message": return "\(command.type):\(string("sessionId")):\(string("text"))"
        case "feed.dismiss": return "\(command.type):\(string("itemId"))"
        case "feed.seen": return "\(command.type):\(string("postId"))"
        case "task.timeline.seen": return "\(command.type):\(string("sessionId")):\(string("itemId"))"
        case "user.profile.update": return command.type
        case "agent.profile.update": return "\(command.type):\(string("projectId"))"
        case "review.respond": return "\(command.type):\(string("reviewId")):\(string("decision")):\(string("note"))"
        case "trust.policy.update": return "\(command.type):\(string("projectId"))"
        case "notification.settings.update", "notification.device.register", "notification.device.unregister": return command.type
        case "task.command.retry": return "\(command.type):\(string("commandId"))"
        default: return "\(command.type):\(command.idempotencyKey ?? UUID().uuidString)"
        }
    }

    private func persistOutbox() {
        if let data = try? JSONEncoder().encode(outbox) {
            UserDefaults.standard.set(data, forKey: outboxKey)
        }
    }

    private func acknowledge(_ message: ServerEnvelope) {
        outbox.removeAll { entry in
            switch message.type {
            case "task.command.updated":
                guard let command = message.command else { return false }
                if entry.command.type == "task.command.retry",
                   case .string(let commandId) = entry.command.values["commandId"] {
                    return command.id == commandId
                }
                return entry.command.idempotencyKey == command.idempotencyKey
                    || command.idempotencyKey.hasSuffix(":\(entry.command.idempotencyKey ?? "")")
            case "feed.dismissed.updated":
                guard case .string(let itemId) = entry.command.values["itemId"] else { return false }
                return entry.command.type == "feed.dismiss" && itemId == message.itemId
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
            case "review.updated":
                guard let review = message.review, case .string(let reviewId) = entry.command.values["reviewId"] else { return false }
                return entry.command.type == "review.respond" && review.id == reviewId
            case "trust.policy.updated":
                guard let policy = message.policy, case .string(let projectId) = entry.command.values["projectId"] else { return false }
                return entry.command.type == "trust.policy.update" && policy.projectId == projectId
            case "notification.settings.updated":
                return entry.command.type == "notification.settings.update"
            case "notification.device.updated":
                return ["notification.device.register", "notification.device.unregister"].contains(entry.command.type)
            case "action.result":
                guard message.ok == true, case .string(let actionId) = entry.command.values["actionId"] else { return false }
                return entry.command.type == "action.decide" && actionId == message.actionId
            default: return false
            }
        }
        persistOutbox()
    }

    private func apply(_ message: ServerEnvelope) {
        acknowledge(message)
        switch message.type {
        case "session.snapshot":
            if let snapshot = message.snapshot {
                self.snapshot = snapshot
                if let sessionId = UserDefaults.standard.string(forKey: "zimlo.pending-push-route"),
                   snapshot.sessions.contains(where: { $0.id == sessionId }) {
                    UserDefaults.standard.removeObject(forKey: "zimlo.pending-push-route")
                    openTask(sessionId: sessionId)
                }
            }
        case "user.profile.updated":
            if let profile = message.userProfile { snapshot.userProfile = profile }
        case "project.updated":
            if let project = message.project { upsert(&snapshot.projects, project) }
        case "session.updated":
            if let session = message.session {
                upsert(&snapshot.sessions, session)
                if selectedSession?.id == session.id { selectedSession = session }
            }
        case "session.removed":
            snapshot.sessions.removeAll { $0.id == message.sessionId }
        case "feed.posted":
            if let post = message.post { upsert(&snapshot.posts, post) }
        case "task.updated":
            if let task = message.task { upsert(&snapshot.tasks, task) }
        case "task.command.updated":
            if let command = message.command { upsert(&snapshot.commands, command) }
        case "feed.seen.updated":
            if let postId = message.postId, !snapshot.seenPostIds.contains(postId) { snapshot.seenPostIds.append(postId) }
        case "feed.dismissed.updated":
            if let itemId = message.itemId, !snapshot.dismissedFeedItemIds.contains(itemId) { snapshot.dismissedFeedItemIds.append(itemId) }
        case "task.timeline.seen.updated":
            if let sessionId = message.sessionId, let itemId = message.itemId { snapshot.taskTimelineCursors[sessionId] = itemId }
        case "task.preference.updated":
            if let preference = message.preference { upsert(&snapshot.taskPreferences, preference) }
        case "review.updated":
            if let review = message.review { upsert(&snapshot.reviews, review) }
        case "reviews.list":
            if let reviews = message.reviews { snapshot.reviews = reviews }
        case "trust.policy.updated":
            if let policy = message.policy { upsert(&snapshot.trustPolicies, policy) }
        case "trust.policies":
            if let policies = message.policies { snapshot.trustPolicies = policies }
            if let audit = message.audit { snapshot.trustAudit = audit }
        case "notification.settings.updated":
            if let settings = message.settings { snapshot.notificationSettings = settings }
        case "notification.device.updated":
            snapshot.pushDevices = message.registration.map { [$0] } ?? []
        case "action.upsert":
            if let action = message.action { upsert(&snapshot.actions, action) }
        case "session.events":
            if let sessionId = message.sessionId, let events = message.events { self.events[sessionId] = events }
        case "event.upsert":
            if let event = message.event { events[event.sessionId, default: []].append(event) }
        case "action.result", "session.message.result":
            notice = message.message
        case "error":
            notice = message.message ?? "Bridge 返回错误"
        default:
            break
        }
        SnapshotCache.save(snapshot)
    }

    private func upsert<T: Identifiable>(_ values: inout [T], _ value: T) where T.ID: Equatable {
        if let index = values.firstIndex(where: { $0.id == value.id }) { values[index] = value }
        else { values.insert(value, at: 0) }
    }
}
