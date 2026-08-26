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
        case .string(let value): return value
        case .number(let value): return String(value)
        case .bool(let value): return value ? "true" : "false"
        case .array(let values): return values.compactMap(\.stringValue).joined(separator: " ")
        case .object(let value):
            for key in ["summary", "message", "reason", "text", "content", "file_path", "path", "diff", "patch", "changes"] {
                if let text = value[key]?.stringValue, !text.isEmpty { return text }
            }
            return nil
        case .null: return nil
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
    var hostId: String? = nil
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
    var hostId: String? = nil
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
        let surfaceLabel: String
        switch surface {
        case "gui": surfaceLabel = "GUI"
        case "cli": surfaceLabel = "CLI"
        case "managed": surfaceLabel = "Managed"
        default: surfaceLabel = "Runtime"
        }
        return "\(provider.label) · \(surfaceLabel)"
    }
}

struct FeedPost: Codable, Hashable, Identifiable {
    var id: String
    var hostId: String? = nil
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

struct FeedContent: Codable, Hashable {
    var type: String
    var materialIds: [String]?
    var materialId: String?
    var posterMaterialId: String?
    var coverMaterialId: String?
    var caption: String?
    var summary: String?
}

struct Material: Codable, Hashable, Identifiable {
    var id: String
    var hostId: String? = nil
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
    var hostId: String? = nil
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

struct ProjectTrustPolicy: Codable, Hashable, Identifiable {
    var hostId: String? = nil
    var projectId: String
    var preset: String
    var autoAllow: [String]
    var updatedAt: String
    var updatedByDeviceId: String
    var id: String { projectId }
}

struct TrustAuditEntry: Codable, Hashable, Identifiable {
    var id: String
    var hostId: String? = nil
    var projectId: String
    var sessionId: String
    var deviceId: String
    var category: String
    var decision: String
    var reason: String
    var actionSummary: String
    var createdAt: String
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

struct PushDeviceRegistration: Codable, Hashable, Identifiable {
    var deviceId: String
    var platform: String
    var endpoint: String
    var publicKey: String
    var active: Bool
    var environment: String
    var registeredAt: String
    var updatedAt: String
    var lastDeliveryKind: String?
    var lastDeliveryStatus: Int?
    var lastDeliveryAt: String?
    var id: String { deviceId }

    private enum CodingKeys: String, CodingKey {
        case deviceId, platform, endpoint, publicKey, active, environment
        case registeredAt, updatedAt, lastDeliveryKind, lastDeliveryStatus, lastDeliveryAt
    }

    init(
        deviceId: String, platform: String, endpoint: String, publicKey: String, active: Bool,
        environment: String = "production", registeredAt: String, updatedAt: String,
        lastDeliveryKind: String? = nil, lastDeliveryStatus: Int? = nil, lastDeliveryAt: String? = nil
    ) {
        self.deviceId = deviceId
        self.platform = platform
        self.endpoint = endpoint
        self.publicKey = publicKey
        self.active = active
        self.environment = environment
        self.registeredAt = registeredAt
        self.updatedAt = updatedAt
        self.lastDeliveryKind = lastDeliveryKind
        self.lastDeliveryStatus = lastDeliveryStatus
        self.lastDeliveryAt = lastDeliveryAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        deviceId = try container.decode(String.self, forKey: .deviceId)
        platform = try container.decode(String.self, forKey: .platform)
        endpoint = try container.decode(String.self, forKey: .endpoint)
        publicKey = try container.decode(String.self, forKey: .publicKey)
        active = try container.decode(Bool.self, forKey: .active)
        environment = try container.decodeIfPresent(String.self, forKey: .environment) ?? "production"
        registeredAt = try container.decode(String.self, forKey: .registeredAt)
        updatedAt = try container.decode(String.self, forKey: .updatedAt)
        lastDeliveryKind = try container.decodeIfPresent(String.self, forKey: .lastDeliveryKind)
        lastDeliveryStatus = try container.decodeIfPresent(Int.self, forKey: .lastDeliveryStatus)
        lastDeliveryAt = try container.decodeIfPresent(String.self, forKey: .lastDeliveryAt)
    }
}

struct FeatureCapabilities: Codable, Hashable {
    var projectTrustPolicy: Bool
    var pushNotifications: Bool
    var remoteSync: Bool
    var multiHost: Bool

    private enum CodingKeys: String, CodingKey {
        case projectTrustPolicy, pushNotifications, remoteSync, multiHost
    }

    init(projectTrustPolicy: Bool, pushNotifications: Bool, remoteSync: Bool, multiHost: Bool = false) {
        self.projectTrustPolicy = projectTrustPolicy
        self.pushNotifications = pushNotifications
        self.remoteSync = remoteSync
        self.multiHost = multiHost
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        projectTrustPolicy = try container.decodeIfPresent(Bool.self, forKey: .projectTrustPolicy) ?? false
        pushNotifications = try container.decodeIfPresent(Bool.self, forKey: .pushNotifications) ?? false
        remoteSync = try container.decodeIfPresent(Bool.self, forKey: .remoteSync) ?? false
        multiHost = try container.decodeIfPresent(Bool.self, forKey: .multiHost) ?? false
    }
}

struct TaskRecord: Codable, Hashable, Identifiable {
    var id: String
    var hostId: String? = nil
    var runId: String
    var agentId: String
    var sessionId: String?
    var state: String
    var reason: String
    var updatedAt: String
}

struct TaskCommand: Codable, Hashable, Identifiable {
    var id: String
    var hostId: String? = nil
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
    var hostId: String? = nil
    var label: String
    var path: String
    var providers: [Provider]
    var lastUsedAt: String
}

struct TaskPreference: Codable, Hashable, Identifiable {
    var hostId: String? = nil
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

struct Snapshot: Codable, Hashable {
    var host: ZimloHost?
    var userProfile: UserProfile
    var projects: [Project]
    var sessions: [AgentSession]
    var posts: [FeedPost]
    var tasks: [TaskRecord]
    var commands: [TaskCommand]
    var materials: [Material]
    var workspaces: [TrustedWorkspace]
    var seenPostIds: [String]
    var dismissedFeedItemIds: [String]
    var taskTimelineCursors: [String: String]
    var taskPreferences: [TaskPreference]
    var actions: [PendingAction]
    var trustPolicies: [ProjectTrustPolicy]
    var trustAudit: [TrustAuditEntry]
    var notificationSettings: NotificationSettings
    var pushDevices: [PushDeviceRegistration]
    var features: FeatureCapabilities
    var sequence: Int
    var lanApprovalsEnabled: Bool
    var trustManagementEnabled: Bool

    static let empty = Snapshot(
        host: nil,
        userProfile: UserProfile(avatarId: "user-01", updatedAt: ""),
        projects: [], sessions: [], posts: [], tasks: [], commands: [], materials: [], workspaces: [],
        seenPostIds: [], dismissedFeedItemIds: [], taskTimelineCursors: [:],
        taskPreferences: [], actions: [], trustPolicies: [], trustAudit: [],
        notificationSettings: NotificationSettings(enabled: false, approvals: true, failures: true, showTaskTitle: false, updatedAt: ""),
        pushDevices: [], features: FeatureCapabilities(
            projectTrustPolicy: false, pushNotifications: false, remoteSync: false
        ),
        sequence: 0, lanApprovalsEnabled: false, trustManagementEnabled: false
    )

    enum CodingKeys: String, CodingKey {
        case host
        case userProfile, projects, sessions, posts, tasks, commands, materials, workspaces
        case seenPostIds, dismissedFeedItemIds, taskTimelineCursors, taskPreferences
        case actions, trustPolicies, trustAudit, notificationSettings, pushDevices, features
        case sequence, lanApprovalsEnabled, trustManagementEnabled
    }

    init(
        host: ZimloHost? = nil, userProfile: UserProfile, projects: [Project], sessions: [AgentSession],
        posts: [FeedPost], tasks: [TaskRecord], commands: [TaskCommand], materials: [Material],
        workspaces: [TrustedWorkspace], seenPostIds: [String],
        dismissedFeedItemIds: [String], taskTimelineCursors: [String: String],
        taskPreferences: [TaskPreference], actions: [PendingAction],
        trustPolicies: [ProjectTrustPolicy], trustAudit: [TrustAuditEntry],
        notificationSettings: NotificationSettings, pushDevices: [PushDeviceRegistration],
        features: FeatureCapabilities,
        sequence: Int, lanApprovalsEnabled: Bool, trustManagementEnabled: Bool
    ) {
        self.host = host
        self.userProfile = userProfile
        self.projects = projects
        self.sessions = sessions
        self.posts = posts
        self.tasks = tasks
        self.commands = commands
        self.materials = materials
        self.workspaces = workspaces
        self.seenPostIds = seenPostIds
        self.dismissedFeedItemIds = dismissedFeedItemIds
        self.taskTimelineCursors = taskTimelineCursors
        self.taskPreferences = taskPreferences
        self.actions = actions
        self.trustPolicies = trustPolicies
        self.trustAudit = trustAudit
        self.notificationSettings = notificationSettings
        self.pushDevices = pushDevices
        self.features = features
        self.sequence = sequence
        self.lanApprovalsEnabled = lanApprovalsEnabled
        self.trustManagementEnabled = trustManagementEnabled
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        host = try c.decodeIfPresent(ZimloHost.self, forKey: .host)
        userProfile = try c.decodeIfPresent(UserProfile.self, forKey: .userProfile) ?? Snapshot.empty.userProfile
        projects = try c.decodeIfPresent([Project].self, forKey: .projects) ?? []
        sessions = try c.decodeIfPresent([AgentSession].self, forKey: .sessions) ?? []
        posts = try c.decodeIfPresent([FeedPost].self, forKey: .posts) ?? []
        tasks = try c.decodeIfPresent([TaskRecord].self, forKey: .tasks) ?? []
        commands = try c.decodeIfPresent([TaskCommand].self, forKey: .commands) ?? []
        materials = try c.decodeIfPresent([Material].self, forKey: .materials) ?? []
        workspaces = try c.decodeIfPresent([TrustedWorkspace].self, forKey: .workspaces) ?? []
        seenPostIds = try c.decodeIfPresent([String].self, forKey: .seenPostIds) ?? []
        dismissedFeedItemIds = try c.decodeIfPresent([String].self, forKey: .dismissedFeedItemIds) ?? []
        taskTimelineCursors = try c.decodeIfPresent([String: String].self, forKey: .taskTimelineCursors) ?? [:]
        taskPreferences = try c.decodeIfPresent([TaskPreference].self, forKey: .taskPreferences) ?? []
        actions = try c.decodeIfPresent([PendingAction].self, forKey: .actions) ?? []
        trustPolicies = try c.decodeIfPresent([ProjectTrustPolicy].self, forKey: .trustPolicies) ?? []
        trustAudit = try c.decodeIfPresent([TrustAuditEntry].self, forKey: .trustAudit) ?? []
        notificationSettings = try c.decodeIfPresent(NotificationSettings.self, forKey: .notificationSettings) ?? Snapshot.empty.notificationSettings
        pushDevices = try c.decodeIfPresent([PushDeviceRegistration].self, forKey: .pushDevices) ?? []
        features = try c.decodeIfPresent(FeatureCapabilities.self, forKey: .features) ?? Snapshot.empty.features
        sequence = try c.decodeIfPresent(Int.self, forKey: .sequence) ?? 0
        lanApprovalsEnabled = try c.decodeIfPresent(Bool.self, forKey: .lanApprovalsEnabled) ?? false
        trustManagementEnabled = try c.decodeIfPresent(Bool.self, forKey: .trustManagementEnabled) ?? false
    }
}

struct ServerEnvelope: Codable {
    var type: String
    var snapshot: Snapshot?
    var userProfile: UserProfile?
    var project: Project?
    var session: AgentSession?
    var sessionId: String?
    var post: FeedPost?
    var task: TaskRecord?
    var command: TaskCommand?
    var material: Material?
    var commandId: String?
    var idempotencyKey: String?
    var postId: String?
    var itemId: String?
    var preference: TaskPreference?
    var policy: ProjectTrustPolicy?
    var policies: [ProjectTrustPolicy]?
    var audit: [TrustAuditEntry]?
    var settings: NotificationSettings?
    var registration: PushDeviceRegistration?
    var action: PendingAction?
    var actionId: String?
    var ok: Bool?
    var message: String?
    var events: [UnifiedEvent]?
    var event: UnifiedEvent?
    var code: String?
}

struct ClientCommand: Codable, Hashable {
    var values: [String: JSONValue]

    init(type: String, _ values: [String: JSONValue] = [:]) {
        self.values = values
        self.values["type"] = .string(type)
    }

    var type: String {
        guard case .string(let value) = values["type"] else { return "" }
        return value
    }

    var idempotencyKey: String? {
        guard case .string(let value) = values["idempotencyKey"] else { return nil }
        return value
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        values = try container.decode([String: JSONValue].self)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(values)
    }
}

struct OutboxEntry: Codable, Hashable, Identifiable {
    var id: String
    var semanticKey: String
    var command: ClientCommand
    var enqueuedAt: String
    // 服务端拒绝时记录原因；nil 表示仍在排队/等待确认。
    var lastError: String?
}

private enum ZimloDateFormats {
    // ISO8601FormatStyle is an immutable Sendable value, so these shared parse
    // strategies stay safe under Swift 6 strict concurrency.
    static let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    static let wholeSecond = Date.ISO8601FormatStyle(includingFractionalSeconds: false)
}

extension String {
    var zimloDate: Date {
        (try? ZimloDateFormats.fractional.parse(self))
            ?? (try? ZimloDateFormats.wholeSecond.parse(self))
            ?? .distantPast
    }
}
