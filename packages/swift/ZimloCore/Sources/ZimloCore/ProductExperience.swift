import Combine
import Foundation

public enum CurrentTaskState {
    public static func resolve(taskState: String?, taskUpdatedAt: String?, sessionState: String,
                               activeCommandCreatedAt: String?, hasPendingAction: Bool) -> String {
        if hasPendingAction { return "waiting" }
        if let started = activeCommandCreatedAt, started > (taskUpdatedAt ?? "") { return "running" }
        return taskState ?? sessionState
    }
}

public struct HistoryEntry: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var hostId: String
    public var kind: String
    public var title: String
    public var summary: String
    public var createdAt: String
    public var projectId: String?
    public var sessionId: String?
    public var materialId: String?
    public var materialIds: [String]
    public var mimeType: String?
    public var sizeBytes: Int?
    public var status: String
}
public struct HistoryPage: Codable, Sendable {
    public var requestId: String
    public var hostId: String
    public var items: [HistoryEntry]
    public var nextCursor: String?
    public var materials: [HistoryMaterial]
}

public struct SetupMilestone: Identifiable, Equatable {
    public let id: String
    public let title: String
    public let detail: String
    public let complete: Bool
}
public enum SetupChecklist {
    public static func steps(connected: Bool, agentReady: Bool, hasProject: Bool, paired: Bool, hasReceipt: Bool) -> [SetupMilestone] {
        [SetupMilestone(id: "connection", title: "连接运行设备", detail: "设备在线后才能同步真实任务。", complete: connected),
         SetupMilestone(id: "agent", title: "接入一个 Agent", detail: "Codex 或 Claude Code 任选一个即可。", complete: agentReady),
         SetupMilestone(id: "project", title: "发现一个项目", detail: "在 Agent 中打开项目并开始一次任务。", complete: hasProject),
         SetupMilestone(id: "phone", title: "连接手机", detail: "使用 Zimlo App 内扫码，确认同步成功。", complete: paired),
         SetupMilestone(id: "receipt", title: "完成一次真实操作", detail: "回复、创建任务或处理审批，等待设备确认。", complete: hasReceipt)]
    }
}

public struct PromptTemplate: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var title: String
    public var text: String
    public init(id: String = UUID().uuidString, title: String, text: String) { self.id = id; self.title = title; self.text = text }
    public static let defaults = [
        PromptTemplate(id: "review", title: "检查改动", text: "检查当前改动，找出影响正确性和用户体验的问题，给出证据并修复可确认的问题。"),
        PromptTemplate(id: "failure", title: "解释失败", text: "定位这次失败的原因，保留已有工作，修复后重新验证，并说明验证结果。"),
        PromptTemplate(id: "continue", title: "继续任务", text: "从已完成的进度继续，完成剩余工作；遇到需要我决定的事项时提供清楚的选项。"),
    ]
}

@MainActor public final class PromptTemplateStore: ObservableObject {
    @Published public private(set) var templates: [PromptTemplate]
    private let defaults: UserDefaults
    private let key = "zimlo.prompt-templates.v1"
    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        templates = defaults.data(forKey: key).flatMap { try? JSONDecoder().decode([PromptTemplate].self, from: $0) } ?? PromptTemplate.defaults
    }
    public func save(_ template: PromptTemplate) {
        guard !template.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !template.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              template.title.count <= 60, template.text.count <= 10_000 else { return }
        var next = templates.filter { $0.id != template.id }; next.append(template)
        persist(Array(next.prefix(30)))
    }
    public func remove(_ id: String) { persist(templates.filter { $0.id != id }) }
    private func persist(_ values: [PromptTemplate]) {
        guard let data = try? JSONEncoder().encode(values) else { return }
        defaults.set(data, forKey: key); templates = values
    }
}

public enum ExperienceMetric: String, Codable, CaseIterable, Sendable {
    case firstSnapshot, snapshotRefresh, commandSaved, commandReceived, commandFailed, approvalReceived, artifactOpened
}
public struct MetricSummary: Codable, Identifiable, Sendable {
    public var id: String
    public var count: Int
    public var p50Milliseconds: Double?
    public var p95Milliseconds: Double?
}
private struct MetricBucket: Codable { var metric: ExperienceMetric; var day: String; var count: Int; var durations: [Double] }

/// Local-only, bounded aggregates. No task IDs, titles, paths, prompts, device
/// names or credentials are accepted by this API or included in exports.
@MainActor public final class ExperienceMetrics: ObservableObject {
    public static let shared = ExperienceMetrics()
    @Published public private(set) var summaries: [MetricSummary] = []
    private var buckets: [MetricBucket] = []
    private let defaults: UserDefaults
    private let key = "zimlo.experience-metrics.v2"
    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        buckets = defaults.data(forKey: key).flatMap { try? JSONDecoder().decode([MetricBucket].self, from: $0) } ?? []
        rebuild()
    }
    public func record(_ metric: ExperienceMetric, milliseconds: Double? = nil, now: Date = Date()) {
        let duration = milliseconds.flatMap { $0.isFinite && $0 >= 0 ? min($0, 3_600_000) : nil }
        let day = String(now.ISO8601Format().prefix(10))
        let cutoff = String(now.addingTimeInterval(-6 * 86_400).ISO8601Format().prefix(10))
        buckets = buckets.filter { $0.day >= cutoff }
        if let index = buckets.firstIndex(where: { $0.metric == metric && $0.day == day }) {
            buckets[index].count += 1
            if let duration { buckets[index].durations = Array((buckets[index].durations + [duration]).suffix(256)) }
        } else { buckets.append(MetricBucket(metric: metric, day: day, count: 1, durations: duration.map { [$0] } ?? [])) }
        if metric == .commandReceived || metric == .approvalReceived { defaults.set(true, forKey: "zimlo.confirmed-operation.v1") }
        if let data = try? JSONEncoder().encode(buckets) { defaults.set(data, forKey: key) }
        rebuild()
    }
    public var hasConfirmedOperation: Bool { defaults.bool(forKey: "zimlo.confirmed-operation.v1") }
    public func export() -> String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return (try? encoder.encode(summaries)).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
    }
    public func clear() { buckets = []; defaults.removeObject(forKey: key); rebuild() }
    private func rebuild() {
        summaries = ExperienceMetric.allCases.map { metric in
            let cutoff = String(Date().addingTimeInterval(-6 * 86_400).ISO8601Format().prefix(10))
            let values = buckets.filter { $0.metric == metric && $0.day >= cutoff }
            let times = values.flatMap(\.durations).sorted()
            func percentile(_ fraction: Double) -> Double? { times.isEmpty ? nil : times[min(times.count - 1, max(0, Int(ceil(Double(times.count) * fraction)) - 1))] }
            return MetricSummary(id: metric.rawValue, count: values.reduce(0) { $0 + $1.count }, p50Milliseconds: percentile(0.5), p95Milliseconds: percentile(0.95))
        }
    }
}
