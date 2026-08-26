import Foundation

enum Provider: String, Codable, CaseIterable, Identifiable {
    case codex
    case claude

    var id: String { rawValue }
    var label: String { self == .codex ? "Codex" : "Claude Code" }
}

enum JSONValue: Codable, Hashable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([String: JSONValue].self) { self = .object(value) }
        else { self = .array(try container.decode([JSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    var stringValue: String? {
        switch self {
        case .string(let value): value
        case .number(let value): String(value)
        case .bool(let value): value ? "true" : "false"
        case .array(let values): values.compactMap(\.stringValue).joined(separator: " ")
        case .object(let values):
            ["prompt", "last_agent_message", "summary", "message", "reason", "text", "content", "preview", "path"]
                .compactMap { values[$0]?.stringValue }
                .first(where: { !$0.isEmpty })
        case .null: nil
        }
    }
}

enum TimelineEventPresentation {
    static func text(for event: UnifiedEvent) -> String? {
        guard let raw = event.payload.stringValue else { return nil }
        var value = TaskPresentationRules.clean(raw)
        if event.kind == "user_instruction",
           let marker = value.range(of: "## My request:\n") {
            value = String(value[marker.upperBound...])
            if let image = value.range(of: "\n<image") { value = String(value[..<image.lowerBound]) }
        }
        value = TaskPresentationRules.clean(value)
        guard !value.isEmpty, value != event.kind else { return nil }
        return value
    }

    static func deduplicated(_ events: [UnifiedEvent]) -> [UnifiedEvent] {
        var seen = Set<String>()
        return events.filter { event in
            guard let text = text(for: event) else { return false }
            let key = text.lowercased().filter { !$0.isWhitespace }
            guard !seen.contains(key) else { return false }
            seen.insert(key)
            return true
        }
    }
}

struct UserProfile: Codable, Hashable {
    var avatarId: String
    var updatedAt: String
}

struct ZimloHost: Codable, Hashable, Identifiable {
    var id: String
    var name: String
    var platform: String
    var lastSeenAt: String
}

struct AgentProfile: Codable, Hashable {
    var displayName: String
    var avatar: String
    var bio: String
    var defaultProvider: Provider?
    var updatedAt: String
}

struct Project: Codable, Hashable, Identifiable {
    var id: String
    var hostId: String?
    var name: String
    var primaryPath: String
    var paths: [String]
    var providers: [Provider]
    var sessionCount: Int
    var postCount: Int
    var agentProfile: AgentProfile
    var createdAt: String
    var lastUsedAt: String
}

struct SessionCapabilities: Codable, Hashable {
    var discovered: Bool
    var liveObserved: Bool
    var replyable: Bool
    var approvableOnce: Bool
    var approvableSession: Bool
    var approvablePersistent: Bool
    var resumable: Bool
    var diffAvailable: Bool
}

struct AgentSession: Codable, Hashable, Identifiable {
    var id: String
    var hostId: String?
    var projectId: String?
    var provider: Provider
    var surface: String
    var providerSessionId: String
    var title: String
    var projectName: String?
    var cwd: String?
    var transcriptPath: String?
    var status: String
    var lastActivityAt: String
    var createdAt: String
    var activePid: Int?
    var processStartedAt: String?
    var tty: String?
    var correlationUncertain: Bool
    var capabilities: SessionCapabilities

    var runtimeLabel: String {
        let surfaceLabel = ["gui": "GUI", "cli": "CLI", "managed": "Managed"][surface] ?? "Runtime"
        return "\(provider.label) · \(surfaceLabel)"
    }
}

struct FeedContent: Codable, Hashable {
    var type: String
    var materialIds: [String]?
    var materialId: String?
    var posterMaterialId: String?
    var coverMaterialId: String?
    var caption: String?
    var summary: String?
}

enum NativeFeedMaterialPresentation: Equatable {
    case imageAlbum([String])
    case video(materialID: String, posterID: String?)
    case document(materialID: String, coverID: String?)
    case none

    init(content: FeedContent) {
        switch content.type {
        case "image_album":
            let ids = content.materialIds ?? []
            self = ids.isEmpty ? .none : .imageAlbum(ids)
        case "video":
            guard let materialID = content.materialId else { self = .none; return }
            self = .video(materialID: materialID, posterID: content.posterMaterialId)
        case "document":
            guard let materialID = content.materialId else { self = .none; return }
            self = .document(materialID: materialID, coverID: content.coverMaterialId)
        default:
            self = .none
        }
    }
}

struct FeedPost: Codable, Hashable, Identifiable {
    var id: String
    var hostId: String?
    var projectId: String?
    var taskId: String
    var runId: String
    var agentId: String
    var sessionId: String?
    var kind: String
    var template: String
    var headline: String
    var takeaway: String
    var highlights: [String]
    var proof: String?
    var content: FeedContent?
    var dedupeKey: String
    var source: String
    var createdAt: String
}

struct Material: Codable, Hashable, Identifiable {
    var id: String
    var hostId: String?
    var kind: String
    var name: String
    var mimeType: String
    var sizeBytes: Int
    var sha256: String
    var width: Int?
    var height: Int?
    var durationMs: Int?
    var previewMaterialId: String?
    var origin: String
    var status: String
    var createdAt: String
    var error: String?
}

struct Decision: Codable, Hashable, Identifiable {
    var id: String
    var label: String
    var scope: String
    var value: JSONValue
    var confirmationPhrase: String?
    var risk: String
}

struct ApprovalContext: Codable, Hashable {
    var category: String
    var projectId: String?
    var cwd: String?
    var command: String?
    var segments: [String]
    var withinProject: Bool
    var reason: String
}

struct PendingAction: Codable, Hashable, Identifiable {
    var actionId: String
    var hostId: String?
    var sessionId: String
    var upstreamRequestId: String?
    var kind: String
    var title: String
    var detail: String
    var availableDecisions: [Decision]
    var expiresAt: String
    var state: String
    var createdAt: String
    var resolvedAt: String?
    var approvalContext: ApprovalContext?
    var id: String { actionId }
}

struct TaskRecord: Codable, Hashable, Identifiable {
    var id: String
    var hostId: String?
    var runId: String
    var agentId: String
    var sessionId: String?
    var state: String
    var reason: String
    var updatedAt: String
}

struct TaskCommand: Codable, Hashable, Identifiable {
    var id: String
    var hostId: String?
    var idempotencyKey: String
    var kind: String
    var provider: Provider
    var sessionId: String?
    var workspaceId: String?
    var cwd: String
    var text: String
    var materialIds: [String]?
    var state: String
    var createdAt: String
    var updatedAt: String
    var error: String?
}

struct TrustedWorkspace: Codable, Hashable, Identifiable {
    var id: String
    var hostId: String?
    var label: String
    var path: String
    var providers: [Provider]
    var lastUsedAt: String
}

struct TaskPreference: Codable, Hashable, Identifiable {
    var hostId: String?
    var sessionId: String
    var pinnedAt: String?
    var archivedAt: String?
    var id: String { sessionId }
}

struct UnifiedEvent: Codable, Hashable, Identifiable {
    var id: String
    var sequence: Int
    var provider: Provider
    var sessionId: String
    var providerSessionId: String
    var turnId: String?
    var itemId: String?
    var kind: String
    var source: String
    var occurredAt: String
    var payload: JSONValue
    var provenance: String
}

struct ProjectTrustPolicy: Codable, Hashable, Identifiable {
    var hostId: String?
    var projectId: String
    var preset: String
    var autoAllow: [String]
    var updatedAt: String
    var updatedByDeviceId: String
    var id: String { projectId }
}

struct NotificationSettings: Codable, Hashable {
    var enabled: Bool
    var approvals: Bool
    var results: Bool
    var failures: Bool
    var criticalOnly: Bool
    var quietHoursEnabled: Bool
    var timeZoneOffsetMinutes: Int
    var showTaskTitle: Bool
    var updatedAt: String

    private enum CodingKeys: String, CodingKey {
        case enabled, approvals, results, failures, criticalOnly, quietHoursEnabled
        case timeZoneOffsetMinutes, showTaskTitle, updatedAt
    }

    init(
        enabled: Bool, approvals: Bool, results: Bool = true, failures: Bool,
        criticalOnly: Bool = false, quietHoursEnabled: Bool = false,
        timeZoneOffsetMinutes: Int = 0, showTaskTitle: Bool, updatedAt: String
    ) {
        self.enabled = enabled
        self.approvals = approvals
        self.results = results
        self.failures = failures
        self.criticalOnly = criticalOnly
        self.quietHoursEnabled = quietHoursEnabled
        self.timeZoneOffsetMinutes = timeZoneOffsetMinutes
        self.showTaskTitle = showTaskTitle
        self.updatedAt = updatedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try container.decode(Bool.self, forKey: .enabled)
        approvals = try container.decode(Bool.self, forKey: .approvals)
        results = try container.decodeIfPresent(Bool.self, forKey: .results) ?? true
        failures = try container.decode(Bool.self, forKey: .failures)
        criticalOnly = try container.decodeIfPresent(Bool.self, forKey: .criticalOnly) ?? false
        quietHoursEnabled = try container.decodeIfPresent(Bool.self, forKey: .quietHoursEnabled) ?? false
        timeZoneOffsetMinutes = try container.decodeIfPresent(Int.self, forKey: .timeZoneOffsetMinutes) ?? 0
        showTaskTitle = try container.decode(Bool.self, forKey: .showTaskTitle)
        updatedAt = try container.decode(String.self, forKey: .updatedAt)
    }
}

struct FeatureCapabilities: Codable, Hashable {
    var projectTrustPolicy: Bool
    var pushNotifications: Bool
    var remoteSync: Bool
    var multiHost: Bool?
}

struct NativeSnapshot: Codable, Hashable {
    var host: ZimloHost?
    var userProfile: UserProfile
    var projects: [Project]
    var sessions: [AgentSession]
    var posts: [FeedPost]
    var materials: [Material]
    var tasks: [TaskRecord]
    var commands: [TaskCommand]
    var workspaces: [TrustedWorkspace]
    var seenPostIds: [String]
    var dismissedFeedItemIds: [String]
    var taskTimelineCursors: [String: String]
    var taskPreferences: [TaskPreference]
    var actions: [PendingAction]
    var trustPolicies: [ProjectTrustPolicy]
    var notificationSettings: NotificationSettings
    var features: FeatureCapabilities
    var sequence: Int
    var lanApprovalsEnabled: Bool
    var trustManagementEnabled: Bool

    static let empty = NativeSnapshot(
        host: nil,
        userProfile: UserProfile(avatarId: "user-01", updatedAt: ""),
        projects: [], sessions: [], posts: [], materials: [], tasks: [], commands: [], workspaces: [],
        seenPostIds: [], dismissedFeedItemIds: [], taskTimelineCursors: [:], taskPreferences: [],
        actions: [], trustPolicies: [],
        notificationSettings: NotificationSettings(
            enabled: false, approvals: true, failures: true, showTaskTitle: false, updatedAt: ""
        ),
        features: FeatureCapabilities(
            projectTrustPolicy: false, pushNotifications: false, remoteSync: false, multiHost: false
        ),
        sequence: 0, lanApprovalsEnabled: false, trustManagementEnabled: false
    )

    private enum CodingKeys: String, CodingKey {
        case host, userProfile, projects, sessions, posts, materials, tasks, commands, workspaces
        case seenPostIds, dismissedFeedItemIds, taskTimelineCursors, taskPreferences, actions
        case trustPolicies, notificationSettings, features, sequence, lanApprovalsEnabled, trustManagementEnabled
    }

    init(
        host: ZimloHost?, userProfile: UserProfile, projects: [Project], sessions: [AgentSession],
        posts: [FeedPost], materials: [Material], tasks: [TaskRecord], commands: [TaskCommand],
        workspaces: [TrustedWorkspace], seenPostIds: [String], dismissedFeedItemIds: [String],
        taskTimelineCursors: [String: String], taskPreferences: [TaskPreference], actions: [PendingAction],
        trustPolicies: [ProjectTrustPolicy], notificationSettings: NotificationSettings,
        features: FeatureCapabilities, sequence: Int, lanApprovalsEnabled: Bool, trustManagementEnabled: Bool
    ) {
        self.host = host
        self.userProfile = userProfile
        self.projects = projects
        self.sessions = sessions
        self.posts = posts
        self.materials = materials
        self.tasks = tasks
        self.commands = commands
        self.workspaces = workspaces
        self.seenPostIds = seenPostIds
        self.dismissedFeedItemIds = dismissedFeedItemIds
        self.taskTimelineCursors = taskTimelineCursors
        self.taskPreferences = taskPreferences
        self.actions = actions
        self.trustPolicies = trustPolicies
        self.notificationSettings = notificationSettings
        self.features = features
        self.sequence = sequence
        self.lanApprovalsEnabled = lanApprovalsEnabled
        self.trustManagementEnabled = trustManagementEnabled
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        host = try container.decodeIfPresent(ZimloHost.self, forKey: .host)
        userProfile = try container.decodeIfPresent(UserProfile.self, forKey: .userProfile) ?? Self.empty.userProfile
        projects = try container.decodeIfPresent([Project].self, forKey: .projects) ?? []
        sessions = try container.decodeIfPresent([AgentSession].self, forKey: .sessions) ?? []
        posts = try container.decodeIfPresent([FeedPost].self, forKey: .posts) ?? []
        materials = try container.decodeIfPresent([Material].self, forKey: .materials) ?? []
        tasks = try container.decodeIfPresent([TaskRecord].self, forKey: .tasks) ?? []
        commands = try container.decodeIfPresent([TaskCommand].self, forKey: .commands) ?? []
        workspaces = try container.decodeIfPresent([TrustedWorkspace].self, forKey: .workspaces) ?? []
        seenPostIds = try container.decodeIfPresent([String].self, forKey: .seenPostIds) ?? []
        dismissedFeedItemIds = try container.decodeIfPresent([String].self, forKey: .dismissedFeedItemIds) ?? []
        taskTimelineCursors = try container.decodeIfPresent([String: String].self, forKey: .taskTimelineCursors) ?? [:]
        taskPreferences = try container.decodeIfPresent([TaskPreference].self, forKey: .taskPreferences) ?? []
        actions = try container.decodeIfPresent([PendingAction].self, forKey: .actions) ?? []
        trustPolicies = try container.decodeIfPresent([ProjectTrustPolicy].self, forKey: .trustPolicies) ?? []
        notificationSettings = try container.decodeIfPresent(NotificationSettings.self, forKey: .notificationSettings) ?? Self.empty.notificationSettings
        features = try container.decodeIfPresent(FeatureCapabilities.self, forKey: .features) ?? Self.empty.features
        sequence = try container.decodeIfPresent(Int.self, forKey: .sequence) ?? 0
        lanApprovalsEnabled = try container.decodeIfPresent(Bool.self, forKey: .lanApprovalsEnabled) ?? false
        trustManagementEnabled = try container.decodeIfPresent(Bool.self, forKey: .trustManagementEnabled) ?? false
    }
}

struct ClientCommand: Codable, Hashable {
    var values: [String: JSONValue]

    init(type: String, _ values: [String: JSONValue] = [:]) {
        self.values = values
        self.values["type"] = .string(type)
    }

    var type: String { values["type"]?.stringValue ?? "" }

    init(from decoder: Decoder) throws {
        values = try decoder.singleValueContainer().decode([String: JSONValue].self)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(values)
    }
}

struct ServerEnvelope: Codable {
    var type: String
    var snapshot: NativeSnapshot?
    var events: [UnifiedEvent]?
    var message: String?
    var code: String?
    var devices: [NativeDevice]?
}

struct NativeDevice: Codable, Hashable, Identifiable {
    var id: String
    var name: String
    var createdAt: String
    var lastSeenAt: String
    var revokedAt: String?
    var isLocalAdmin: Bool
    var canApprove: Bool
    var canManageTrust: Bool

    var isActivePhone: Bool { !isLocalAdmin && revokedAt == nil }
}

struct LocalCommandResponse: Codable {
    var ok: Bool
    var messages: [ServerEnvelope]
    var snapshot: NativeSnapshot
}

struct LocalEventsResponse: Codable {
    var sessionId: String
    var events: [UnifiedEvent]
}

struct BridgeAPIError: Codable, LocalizedError {
    var code: String
    var message: String
    var recoverable: Bool?

    var errorDescription: String? { message }
}

private enum ZimloDateFormats {
    static let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    static let whole = Date.ISO8601FormatStyle(includingFractionalSeconds: false)
}

extension String {
    var zimloDate: Date {
        (try? ZimloDateFormats.fractional.parse(self))
            ?? (try? ZimloDateFormats.whole.parse(self))
            ?? .distantPast
    }
}

enum TaskPresentationRules {
    static func stateLabel(_ state: String) -> String {
        [
            "running": "进行中", "waiting": "等待中", "idle": "可继续", "completed": "已完成",
            "failed": "失败", "ended": "已结束", "waiting_input": "等你回复",
            "reviewing": "检查中", "user_review": "待你审阅",
        ][state] ?? "状态未知"
    }

    static func shortTitle(_ value: String, limit: Int = 28) -> String {
        let normalized = clean(value).trimmingCharacters(in: .whitespacesAndNewlines)
            .split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return normalized.count > limit ? "\(normalized.prefix(limit))…" : (normalized.isEmpty ? "任务" : normalized)
    }

    static func clean(_ value: String) -> String {
        value
            .replacingOccurrences(
                of: #"<oai-mem-citation>[\s\S]*?</oai-mem-citation>"#,
                with: "",
                options: .regularExpression
            )
            .replacingOccurrences(
                of: #"<response-annotations>[\s\S]*?</response-annotations>"#,
                with: "",
                options: .regularExpression
            )
            .replacingOccurrences(
                of: #"::(?:git-[\w-]+|created-thread)\{[^\n]*\}"#,
                with: "",
                options: .regularExpression
            )
            .replacingOccurrences(of: #"\n{3,}"#, with: "\n\n", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func preview(_ value: String, limit: Int = 220) -> String {
        let cleaned = clean(value)
        return cleaned.count > limit ? "\(cleaned.prefix(limit))…" : cleaned
    }
}
