import AppKit
import Combine
import Foundation
@preconcurrency import UserNotifications

struct MacNotificationPreferences: Equatable {
    var enabled: Bool
    var approvals: Bool
    var results: Bool
    var failures: Bool
    var criticalOnly: Bool
    var quietHoursEnabled: Bool
    var showTaskTitle: Bool

    static let defaults = MacNotificationPreferences(
        enabled: true,
        approvals: true,
        results: true,
        failures: true,
        criticalOnly: false,
        quietHoursEnabled: false,
        showTaskTitle: false
    )
}

enum MacNotificationAuthorization: Equatable {
    case checking
    case notDetermined
    case authorized
    case denied
    case unknown

    var isAllowed: Bool {
        self == .authorized
    }

    var label: String {
        switch self {
        case .checking: "正在检查"
        case .notDetermined: "尚未请求"
        case .authorized: "系统已允许"
        case .denied: "系统已拒绝"
        case .unknown: "状态未知"
        }
    }
}

@MainActor
protocol MacNotificationCenterProviding: AnyObject {
    var delegate: UNUserNotificationCenterDelegate? { get set }

    func currentStatus() async -> MacNotificationAuthorization
    func requestAuthorization() async -> Bool
    func removeDeliveredNotifications(withIdentifiers identifiers: [String])
    func add(_ request: UNNotificationRequest) async throws
}

@MainActor
private final class SystemMacNotificationCenter: MacNotificationCenterProviding {
    private let center: UNUserNotificationCenter

    init(center: UNUserNotificationCenter) {
        self.center = center
    }

    var delegate: UNUserNotificationCenterDelegate? {
        get { center.delegate }
        set { center.delegate = newValue }
    }

    func currentStatus() async -> MacNotificationAuthorization {
        switch await center.notificationSettings().authorizationStatus {
        case .notDetermined: .notDetermined
        case .authorized, .provisional, .ephemeral: .authorized
        case .denied: .denied
        @unknown default: .unknown
        }
    }

    func requestAuthorization() async -> Bool {
        (try? await center.requestAuthorization(options: [.alert, .badge, .sound])) == true
    }

    func removeDeliveredNotifications(withIdentifiers identifiers: [String]) {
        center.removeDeliveredNotifications(withIdentifiers: identifiers)
    }

    func add(_ request: UNNotificationRequest) async throws {
        try await center.add(request)
    }
}

enum MacNotificationKind: String, Equatable {
    case approval
    case approvalReminder = "approval_reminder"
    case result
    case failure

    var body: String {
        switch self {
        case .approval: "有一项需要你处理"
        case .approvalReminder: "仍有一项等待你处理"
        case .result: "一项任务有了新结果"
        case .failure: "一项任务需要你查看"
        }
    }

    var priority: Int {
        switch self {
        case .approval, .approvalReminder: 3
        case .failure: 2
        case .result: 1
        }
    }
}

struct MacNotificationCandidate: Equatable {
    var id: String
    var sessionID: String
    var taskTitle: String?
    var kind: MacNotificationKind
    var occurredAt: String
    var taskID: String? = nil
    var summary: String? = nil

    var notificationIdentifier: String {
        let channel = kind == .approval || kind == .approvalReminder ? "action" : "status"
        return "zimlo.session.\(sessionID).\(channel)"
    }
}

enum MacNotificationPolicy {
    private static let summaryLimit = 120

    static func notificationSummary(headline: String, takeaway: String) -> String? {
        let cleanHeadline = compact(headline)
        let cleanTakeaway = compact(takeaway)
        if cleanHeadline.isEmpty { return limited(cleanTakeaway) }
        if cleanTakeaway.isEmpty || cleanTakeaway == cleanHeadline { return limited(cleanHeadline) }
        return limited("\(cleanHeadline)：\(cleanTakeaway)")
    }

    static func notificationSummary(action: PendingAction, reminder: Bool = false) -> String {
        if action.kind == "input" {
            return reminder ? "仍有一个问题等待你回复" : "需要你回复一个问题"
        }
        let prefix = reminder ? "仍待批准" : "需要批准"
        guard let category = action.approvalContext?.category else { return "\(prefix)一项操作" }
        let operation: String
        switch category {
        case "read": operation = "读取项目文件"
        case "search": operation = "搜索项目内容"
        case "test": operation = "运行测试"
        case "build": operation = "构建项目"
        case "write": operation = "修改文件"
        case "install": operation = "安装或更新依赖"
        case "network": operation = "访问网络"
        case "git_publish": operation = "发布 Git 变更"
        case "destructive": operation = "执行可能破坏数据的操作"
        default: operation = "执行一项操作"
        }
        return "\(prefix)：\(operation)"
    }

    private static func compact(_ text: String) -> String {
        text.split(whereSeparator: \Character.isWhitespace).joined(separator: " ")
    }

    private static func limited(_ text: String) -> String? {
        guard !text.isEmpty else { return nil }
        if text.count <= summaryLimit { return text }
        return String(text.prefix(summaryLimit - 1)) + "…"
    }

    static func isCritical(_ kind: MacNotificationKind) -> Bool {
        kind != .result
    }

    static func isInQuietHours(
        preferences: MacNotificationPreferences,
        date: Date = Date(),
        calendar: Calendar = .current
    ) -> Bool {
        guard preferences.quietHoursEnabled else { return false }
        let hour = calendar.component(.hour, from: date)
        return hour >= 22 || hour < 8
    }

    static func shouldDeliver(
        _ kind: MacNotificationKind,
        preferences: MacNotificationPreferences,
        date: Date = Date(),
        calendar: Calendar = .current
    ) -> Bool {
        guard preferences.enabled else { return false }
        let subscribed: Bool
        switch kind {
        case .approval, .approvalReminder: subscribed = preferences.approvals
        case .result: subscribed = preferences.results
        case .failure: subscribed = preferences.failures
        }
        guard subscribed else { return false }
        return !(preferences.criticalOnly || isInQuietHours(preferences: preferences, date: date, calendar: calendar))
            || isCritical(kind)
    }

    static func approvalReminderDelay(action: PendingAction, now: Date = Date()) -> TimeInterval? {
        guard action.state == "pending",
              let expiry = parseISO8601(action.expiresAt) else { return nil }
        let remaining = expiry.timeIntervalSince(now)
        guard remaining >= 90 else { return nil }
        let remindAt = max(now.addingTimeInterval(60), expiry.addingTimeInterval(-5 * 60))
        let delay = remindAt.timeIntervalSince(now)
        return remindAt < expiry ? delay : nil
    }

    private static func parseISO8601(_ text: String) -> Date? {
        if let value = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(text) {
            return value
        }
        return try? Date.ISO8601FormatStyle(includingFractionalSeconds: false).parse(text)
    }

    static func candidates(
        previous: NativeSnapshot,
        next: NativeSnapshot,
        preferences: MacNotificationPreferences
    ) -> [MacNotificationCandidate] {
        guard preferences.enabled else { return [] }
        let oldActionIDs = Set(previous.actions.filter(Self.isActionable).map(\.actionId))
        let oldPostIDs = Set(previous.posts.map(\.id))
        let sessions = Dictionary(uniqueKeysWithValues: next.sessions.map { ($0.id, $0) })
        var values: [MacNotificationCandidate] = []

        if shouldDeliver(.approval, preferences: preferences) {
            values += next.actions
                .filter(Self.isActionable)
                .filter { !oldActionIDs.contains($0.actionId) }
                .map {
                    MacNotificationCandidate(
                        id: "action:\($0.actionId)",
                        sessionID: $0.sessionId,
                        taskTitle: sessions[$0.sessionId]?.title,
                        kind: .approval,
                        occurredAt: $0.createdAt,
                        summary: notificationSummary(action: $0)
                    )
                }
        }

        values += next.posts.compactMap { post in
            guard !oldPostIDs.contains(post.id),
                  !next.seenPostIds.contains(post.id),
                  let sessionID = post.sessionId else { return nil }
            let kind: MacNotificationKind
            switch post.kind {
            case "result" where shouldDeliver(.result, preferences: preferences): kind = .result
            case "failure" where shouldDeliver(.failure, preferences: preferences): kind = .failure
            default: return nil
            }
            return MacNotificationCandidate(
                id: "post:\(post.id)",
                sessionID: sessionID,
                taskTitle: sessions[sessionID]?.title,
                kind: kind,
                occurredAt: post.createdAt,
                taskID: post.taskId,
                summary: notificationSummary(headline: post.headline, takeaway: post.takeaway)
            )
        }

        // A poll can contain several updates for one task. Keep the newest,
        // highest-priority item so reconnects never produce a notification storm.
        var bySession: [String: MacNotificationCandidate] = [:]
        for candidate in values {
            guard let current = bySession[candidate.sessionID] else {
                bySession[candidate.sessionID] = candidate
                continue
            }
            if candidate.kind.priority > current.kind.priority
                || (candidate.kind.priority == current.kind.priority && candidate.occurredAt > current.occurredAt) {
                bySession[candidate.sessionID] = candidate
            }
        }
        return bySession.values.sorted { $0.occurredAt > $1.occurredAt }.prefix(4).map { $0 }
    }

    static func unreadCount(snapshot: NativeSnapshot, preferences: MacNotificationPreferences) -> Int {
        guard preferences.enabled else { return 0 }
        let actions = preferences.approvals ? snapshot.actions.filter(isActionable).count : 0
        let posts = snapshot.posts.filter { post in
            guard !snapshot.seenPostIds.contains(post.id) else { return false }
            return (preferences.results && !preferences.criticalOnly && post.kind == "result")
                || (preferences.failures && post.kind == "failure")
        }.count
        return min(actions + posts, 99)
    }

    static func resolvedActionSessionIDs(previous: NativeSnapshot, next: NativeSnapshot) -> Set<String> {
        let previousSessions = Set(previous.actions.filter(isActionable).map(\.sessionId))
        let nextSessions = Set(next.actions.filter(isActionable).map(\.sessionId))
        return previousSessions.subtracting(nextSessions)
    }

    static func failureFallbackCandidates(
        previous: NativeSnapshot,
        next: NativeSnapshot,
        preferences: MacNotificationPreferences
    ) -> [MacNotificationCandidate] {
        guard shouldDeliver(.failure, preferences: preferences) else { return [] }
        let previousTasks = Dictionary(uniqueKeysWithValues: previous.tasks.map { ($0.id, $0) })
        let previousPostIDs = Set(previous.posts.map(\.id))
        let newFailureTaskIDs = Set(next.posts.filter {
            $0.kind == "failure" && !previousPostIDs.contains($0.id)
        }.map(\.taskId))
        let sessions = Dictionary(uniqueKeysWithValues: next.sessions.map { ($0.id, $0) })
        return next.tasks.compactMap { task in
            guard task.state == "failed",
                  previousTasks[task.id]?.state != "failed" || previousTasks[task.id]?.sessionId == nil,
                  !newFailureTaskIDs.contains(task.id),
                  let sessionID = task.sessionId else { return nil }
            return MacNotificationCandidate(
                id: "task:\(task.id)",
                sessionID: sessionID,
                taskTitle: sessions[sessionID]?.title,
                kind: .failure,
                occurredAt: task.updatedAt,
                taskID: task.id
            )
        }
    }

    private static func isActionable(_ action: PendingAction) -> Bool {
        action.state == "pending"
    }
}

@MainActor
final class MacNotificationManager: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = MacNotificationManager()

    @Published private(set) var preferences: MacNotificationPreferences
    @Published private(set) var authorization: MacNotificationAuthorization = .checking

    var authorizationLabel: String { authorization.label }
    var authorizationDenied: Bool { authorization == .denied }
    var effectiveEnabled: Bool { preferences.enabled && authorization.isAllowed }

    private enum Key {
        static let enabled = "zimlo.notifications.enabled.v1"
        static let approvals = "zimlo.notifications.approvals.v1"
        static let results = "zimlo.notifications.results.v1"
        static let failures = "zimlo.notifications.failures.v1"
        static let criticalOnly = "zimlo.notifications.critical-only.v1"
        static let quietHoursEnabled = "zimlo.notifications.quiet-hours.v1"
        static let showTaskTitle = "zimlo.notifications.show-task-title.v1"
        static let remindedActions = "zimlo.notifications.reminded-actions.v1"
    }

    private let center: MacNotificationCenterProviding
    private let defaults: UserDefaults
    private var visibleSessionID: String?
    private var failureFallbackTasks: [String: Task<Void, Never>] = [:]
    private var failureFallbackNotifiedTaskIDs = Set<String>()
    private var latestTaskStates: [String: String] = [:]
    private var latestSnapshot = NativeSnapshot.empty
    private var statusDeliveryTasks: [String: Task<Void, Never>] = [:]
    private var pendingStatusCandidates: [String: MacNotificationCandidate] = [:]
    private var approvalReminderTasks: [String: Task<Void, Never>] = [:]
    private var remindedActionIDs: Set<String>

    init(
        center: MacNotificationCenterProviding? = nil,
        defaults: UserDefaults = .standard
    ) {
        self.center = center ?? SystemMacNotificationCenter(center: .current())
        self.defaults = defaults
        preferences = Self.loadPreferences(defaults)
        remindedActionIDs = Set(defaults.stringArray(forKey: Key.remindedActions) ?? [])
        super.init()
    }

    func configure(requestPermission: Bool) {
        center.delegate = self
        Task {
            if requestPermission && preferences.enabled {
                _ = await requestAuthorizationIfNeeded()
            } else {
                await refreshAuthorization()
            }
        }
    }

    @discardableResult
    func setEnabled(_ enabled: Bool) async -> Bool {
        update(\.enabled, enabled)
        if !enabled {
            updateBadge(latestSnapshot)
            return true
        }
        let allowed = await requestAuthorizationIfNeeded()
        updateBadge(latestSnapshot)
        return allowed
    }

    func setApprovals(_ enabled: Bool) { update(\.approvals, enabled) }
    func setResults(_ enabled: Bool) { update(\.results, enabled) }
    func setFailures(_ enabled: Bool) { update(\.failures, enabled) }
    func setCriticalOnly(_ enabled: Bool) { update(\.criticalOnly, enabled) }
    func setQuietHoursEnabled(_ enabled: Bool) { update(\.quietHoursEnabled, enabled) }
    func setShowTaskTitle(_ enabled: Bool) { update(\.showTaskTitle, enabled) }

    func setVisibleSessionID(_ sessionID: String?) {
        visibleSessionID = sessionID
    }

    func process(previous: NativeSnapshot, next: NativeSnapshot) async {
        updateBadge(next)
        let deliveryPreferences = effectivePreferences
        let resolvedActionIdentifiers = MacNotificationPolicy.resolvedActionSessionIDs(previous: previous, next: next)
            .map { "zimlo.session.\($0).action" }
        center.removeDeliveredNotifications(withIdentifiers: resolvedActionIdentifiers)
        let previousPostIDs = Set(previous.posts.map(\.id))
        let newFailurePosts = next.posts.filter {
            $0.kind == "failure" && !previousPostIDs.contains($0.id)
        }
        var suppressedFailurePostIDs = Set<String>()
        for post in newFailurePosts {
            failureFallbackTasks.removeValue(forKey: post.taskId)?.cancel()
            if failureFallbackNotifiedTaskIDs.remove(post.taskId) != nil {
                suppressedFailurePostIDs.insert("post:\(post.id)")
            }
        }
        let nextTaskStates = Dictionary(uniqueKeysWithValues: next.tasks.map { ($0.id, $0.state) })
        let staleFallbackTaskIDs = failureFallbackTasks.keys.filter { nextTaskStates[$0] != "failed" }
        for taskID in staleFallbackTaskIDs {
            failureFallbackTasks.removeValue(forKey: taskID)?.cancel()
            failureFallbackNotifiedTaskIDs.remove(taskID)
        }
        latestTaskStates = nextTaskStates
        for candidate in MacNotificationPolicy.failureFallbackCandidates(
            previous: previous,
            next: next,
            preferences: deliveryPreferences
        ) {
            scheduleFailureFallback(candidate, snapshot: next)
        }
        let candidates = MacNotificationPolicy.candidates(
            previous: previous,
            next: next,
            preferences: deliveryPreferences
        ).filter { !suppressedFailurePostIDs.contains($0.id) }
        let badgeCount = MacNotificationPolicy.unreadCount(snapshot: next, preferences: deliveryPreferences)
        await deliver(candidates.filter { $0.kind == .approval }, badgeCount: badgeCount)
        for candidate in candidates where candidate.kind != .approval {
            scheduleStatusDelivery(candidate, badgeCount: badgeCount)
        }
    }

    private func scheduleFailureFallback(_ candidate: MacNotificationCandidate, snapshot: NativeSnapshot) {
        guard let taskID = candidate.taskID, failureFallbackTasks[taskID] == nil else { return }
        failureFallbackTasks[taskID] = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(5)) }
            catch { return }
            guard let self, self.latestTaskStates[taskID] == "failed" else { return }
            self.failureFallbackTasks.removeValue(forKey: taskID)
            self.failureFallbackNotifiedTaskIDs.insert(taskID)
            let badgeCount = max(1, MacNotificationPolicy.unreadCount(
                snapshot: snapshot,
                preferences: self.effectivePreferences
            ))
            self.scheduleStatusDelivery(candidate, badgeCount: badgeCount)
        }
    }

    private func scheduleStatusDelivery(_ candidate: MacNotificationCandidate, badgeCount: Int) {
        let sessionID = candidate.sessionID
        if let current = pendingStatusCandidates[sessionID] {
            if candidate.kind.priority > current.kind.priority
                || (candidate.kind.priority == current.kind.priority && candidate.occurredAt > current.occurredAt) {
                pendingStatusCandidates[sessionID] = candidate
            }
            return
        }
        pendingStatusCandidates[sessionID] = candidate
        statusDeliveryTasks[sessionID] = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(2)) }
            catch { return }
            guard let self, let pending = self.pendingStatusCandidates.removeValue(forKey: sessionID) else { return }
            self.statusDeliveryTasks.removeValue(forKey: sessionID)
            await self.deliver([pending], badgeCount: badgeCount)
        }
    }

    private func deliver(_ candidates: [MacNotificationCandidate], badgeCount: Int) async {
        guard effectiveEnabled else { return }
        let eligibleCandidates = candidates.filter {
            MacNotificationPolicy.shouldDeliver($0.kind, preferences: effectivePreferences)
        }
        guard !eligibleCandidates.isEmpty, await requestAuthorizationIfNeeded() else { return }
        for candidate in eligibleCandidates {
            let content = UNMutableNotificationContent()
            if preferences.showTaskTitle,
               let taskTitle = candidate.taskTitle?.trimmingCharacters(in: .whitespacesAndNewlines),
               !taskTitle.isEmpty {
                content.title = taskTitle
            } else {
                content.title = "Zimlo"
            }
            content.body = preferences.showTaskTitle ? (candidate.summary ?? candidate.kind.body) : candidate.kind.body
            content.sound = .default
            content.threadIdentifier = candidate.sessionID
            content.userInfo = ["sessionId": candidate.sessionID, "eventId": candidate.id]
            content.badge = NSNumber(value: badgeCount)
            let identifier = candidate.notificationIdentifier
            center.removeDeliveredNotifications(withIdentifiers: [identifier])
            try? await center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil))
        }
    }

    func updateBadge(_ snapshot: NativeSnapshot) {
        latestSnapshot = snapshot
        syncApprovalReminders(snapshot)
        let count = MacNotificationPolicy.unreadCount(snapshot: snapshot, preferences: effectivePreferences)
        NSApp?.dockTile.badgeLabel = count == 0 ? nil : String(count)
    }

    private func syncApprovalReminders(_ snapshot: NativeSnapshot) {
        guard MacNotificationPolicy.shouldDeliver(.approvalReminder, preferences: effectivePreferences) else {
            for task in approvalReminderTasks.values { task.cancel() }
            approvalReminderTasks.removeAll()
            return
        }
        let pending = Dictionary(uniqueKeysWithValues: snapshot.actions
            .filter { $0.state == "pending" }
            .map { ($0.actionId, $0) })
        for actionID in approvalReminderTasks.keys where pending[actionID] == nil {
            approvalReminderTasks.removeValue(forKey: actionID)?.cancel()
        }
        for action in pending.values {
            guard approvalReminderTasks[action.actionId] == nil,
                  !remindedActionIDs.contains(action.actionId),
                  let delay = MacNotificationPolicy.approvalReminderDelay(action: action) else { continue }
            approvalReminderTasks[action.actionId] = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(delay)) }
                catch { return }
                guard let self,
                      self.latestSnapshot.actions.contains(where: {
                        $0.actionId == action.actionId && $0.state == "pending"
                      }) else { return }
                self.approvalReminderTasks.removeValue(forKey: action.actionId)
                self.remindedActionIDs.insert(action.actionId)
                self.defaults.set(Array(self.remindedActionIDs), forKey: Key.remindedActions)
                let title = self.latestSnapshot.sessions.first(where: { $0.id == action.sessionId })?.title
                let candidate = MacNotificationCandidate(
                    id: "action-reminder:\(action.actionId)",
                    sessionID: action.sessionId,
                    taskTitle: title,
                    kind: .approvalReminder,
                    occurredAt: ISO8601DateFormatter().string(from: Date()),
                    summary: MacNotificationPolicy.notificationSummary(action: action, reminder: true)
                )
                let badge = max(1, MacNotificationPolicy.unreadCount(
                    snapshot: self.latestSnapshot,
                    preferences: self.effectivePreferences
                ))
                await self.deliver([candidate], badgeCount: badge)
            }
        }
    }

    @discardableResult
    func requestAuthorizationIfNeeded() async -> Bool {
        let status = await center.currentStatus()
        let allowed: Bool
        switch status {
        case .notDetermined:
            allowed = await center.requestAuthorization()
        case .authorized:
            allowed = true
        case .checking, .denied, .unknown:
            allowed = false
        }
        await refreshAuthorization()
        return allowed
    }

    func openSystemSettings() {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.notifications") else { return }
        NSWorkspace.shared.open(url)
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        let sessionID = notification.request.content.userInfo["sessionId"] as? String
        let shouldSuppress = await MainActor.run {
            WindowCoordinator.shared.mainWindowIsKey && self.visibleSessionID == sessionID
        }
        return shouldSuppress ? [] : [.banner, .list, .sound, .badge]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        guard let sessionID = response.notification.request.content.userInfo["sessionId"] as? String else { return }
        await MainActor.run { WindowCoordinator.shared.openTask(sessionID: sessionID) }
    }

    func refreshAuthorization() async {
        authorization = await center.currentStatus()
        updateBadge(latestSnapshot)
    }

    private var effectivePreferences: MacNotificationPreferences {
        var value = preferences
        value.enabled = effectiveEnabled
        return value
    }

    private func update(_ keyPath: WritableKeyPath<MacNotificationPreferences, Bool>, _ value: Bool) {
        preferences[keyPath: keyPath] = value
        defaults.set(preferences.enabled, forKey: Key.enabled)
        defaults.set(preferences.approvals, forKey: Key.approvals)
        defaults.set(preferences.results, forKey: Key.results)
        defaults.set(preferences.failures, forKey: Key.failures)
        defaults.set(preferences.criticalOnly, forKey: Key.criticalOnly)
        defaults.set(preferences.quietHoursEnabled, forKey: Key.quietHoursEnabled)
        defaults.set(preferences.showTaskTitle, forKey: Key.showTaskTitle)
    }

    private static func loadPreferences(_ defaults: UserDefaults) -> MacNotificationPreferences {
        func value(_ key: String, fallback: Bool) -> Bool {
            defaults.object(forKey: key) == nil ? fallback : defaults.bool(forKey: key)
        }
        return MacNotificationPreferences(
            enabled: value(Key.enabled, fallback: MacNotificationPreferences.defaults.enabled),
            approvals: value(Key.approvals, fallback: MacNotificationPreferences.defaults.approvals),
            results: value(Key.results, fallback: MacNotificationPreferences.defaults.results),
            failures: value(Key.failures, fallback: MacNotificationPreferences.defaults.failures),
            criticalOnly: value(Key.criticalOnly, fallback: MacNotificationPreferences.defaults.criticalOnly),
            quietHoursEnabled: value(Key.quietHoursEnabled, fallback: MacNotificationPreferences.defaults.quietHoursEnabled),
            showTaskTitle: value(Key.showTaskTitle, fallback: MacNotificationPreferences.defaults.showTaskTitle)
        )
    }
}
