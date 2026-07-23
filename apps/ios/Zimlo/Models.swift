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

struct AgentProfile: Codable, Hashable {
    var displayName: String
    var avatar: String
    var bio: String
    var defaultProvider: Provider?
    var updatedAt: String
}

struct Project: Codable, Hashable, Identifiable {
    var id: String
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
    var actionRequired: Bool
    var actionPrompt: String?
    var actions: [String]
    var pendingActionIds: [String]
    var dedupeKey: String
    var source: String
    var createdAt: String
}

struct Decision: Codable, Hashable, Identifiable {
    var id: String
    var label: String
    var scope: String
    var value: JSONValue
    var confirmationPhrase: String?
    var risk: String
}

struct PendingAction: Codable, Hashable, Identifiable {
    var actionId: String
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
    var id: String { actionId }
}

struct TaskRecord: Codable, Hashable, Identifiable {
    var id: String
    var runId: String
    var agentId: String
    var sessionId: String?
    var state: String
    var reason: String
    var updatedAt: String
}

struct TaskCommand: Codable, Hashable, Identifiable {
    var id: String
    var idempotencyKey: String
    var kind: String
    var provider: Provider
    var sessionId: String?
    var workspaceId: String?
    var cwd: String
    var text: String
    var state: String
    var createdAt: String
    var updatedAt: String
    var error: String?
}

struct TrustedWorkspace: Codable, Hashable, Identifiable {
    var id: String
    var label: String
    var path: String
    var providers: [Provider]
    var lastUsedAt: String
}

struct TaskPreference: Codable, Hashable, Identifiable {
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
    var userProfile: UserProfile
    var projects: [Project]
    var sessions: [AgentSession]
    var posts: [FeedPost]
    var tasks: [TaskRecord]
    var commands: [TaskCommand]
    var workspaces: [TrustedWorkspace]
    var seenPostIds: [String]
    var dismissedFeedItemIds: [String]
    var taskTimelineCursors: [String: String]
    var taskPreferences: [TaskPreference]
    var actions: [PendingAction]
    var sequence: Int
    var lanApprovalsEnabled: Bool

    static let empty = Snapshot(
        userProfile: UserProfile(avatarId: "user-01", updatedAt: ""),
        projects: [], sessions: [], posts: [], tasks: [], commands: [], workspaces: [],
        seenPostIds: [], dismissedFeedItemIds: [], taskTimelineCursors: [:],
        taskPreferences: [], actions: [], sequence: 0, lanApprovalsEnabled: false
    )

    enum CodingKeys: String, CodingKey {
        case userProfile, projects, sessions, posts, tasks, commands, workspaces
        case seenPostIds, dismissedFeedItemIds, taskTimelineCursors, taskPreferences
        case actions, sequence, lanApprovalsEnabled
    }

    init(
        userProfile: UserProfile, projects: [Project], sessions: [AgentSession],
        posts: [FeedPost], tasks: [TaskRecord], commands: [TaskCommand],
        workspaces: [TrustedWorkspace], seenPostIds: [String],
        dismissedFeedItemIds: [String], taskTimelineCursors: [String: String],
        taskPreferences: [TaskPreference], actions: [PendingAction],
        sequence: Int, lanApprovalsEnabled: Bool
    ) {
        self.userProfile = userProfile
        self.projects = projects
        self.sessions = sessions
        self.posts = posts
        self.tasks = tasks
        self.commands = commands
        self.workspaces = workspaces
        self.seenPostIds = seenPostIds
        self.dismissedFeedItemIds = dismissedFeedItemIds
        self.taskTimelineCursors = taskTimelineCursors
        self.taskPreferences = taskPreferences
        self.actions = actions
        self.sequence = sequence
        self.lanApprovalsEnabled = lanApprovalsEnabled
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        userProfile = try c.decodeIfPresent(UserProfile.self, forKey: .userProfile) ?? Snapshot.empty.userProfile
        projects = try c.decodeIfPresent([Project].self, forKey: .projects) ?? []
        sessions = try c.decodeIfPresent([AgentSession].self, forKey: .sessions) ?? []
        posts = try c.decodeIfPresent([FeedPost].self, forKey: .posts) ?? []
        tasks = try c.decodeIfPresent([TaskRecord].self, forKey: .tasks) ?? []
        commands = try c.decodeIfPresent([TaskCommand].self, forKey: .commands) ?? []
        workspaces = try c.decodeIfPresent([TrustedWorkspace].self, forKey: .workspaces) ?? []
        seenPostIds = try c.decodeIfPresent([String].self, forKey: .seenPostIds) ?? []
        dismissedFeedItemIds = try c.decodeIfPresent([String].self, forKey: .dismissedFeedItemIds) ?? []
        taskTimelineCursors = try c.decodeIfPresent([String: String].self, forKey: .taskTimelineCursors) ?? [:]
        taskPreferences = try c.decodeIfPresent([TaskPreference].self, forKey: .taskPreferences) ?? []
        actions = try c.decodeIfPresent([PendingAction].self, forKey: .actions) ?? []
        sequence = try c.decodeIfPresent(Int.self, forKey: .sequence) ?? 0
        lanApprovalsEnabled = try c.decodeIfPresent(Bool.self, forKey: .lanApprovalsEnabled) ?? false
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
    var postId: String?
    var itemId: String?
    var preference: TaskPreference?
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
}

extension ISO8601DateFormatter {
    static let zimlo: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

extension String {
    var zimloDate: Date {
        ISO8601DateFormatter.zimlo.date(from: self)
            ?? ISO8601DateFormatter().date(from: self)
            ?? .distantPast
    }
}
