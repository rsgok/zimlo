import Foundation

// 与 packages/protocol/src/policy.ts 逐行对齐的共享规则。packages/protocol/test-vectors
// 下的版本化 JSON 用例同时驱动 vitest 与 ZimloTests/VectorTests.swift，任何改动必须
// 先改向量与 TS，再改这里。

// MARK: - Feed

enum FeedRules {
    static let mergeWindow: TimeInterval = 6 * 60 * 60
    static let postValue: [String: Int] = ["failure": 1, "result": 2, "decision": 3, "attention": 3, "progress": 4]
    static let routineKinds: Set<String> = ["progress", "decision"]
    static let coverableKinds: Set<String> = ["progress", "decision", "attention"]
    static let outcomeKinds: Set<String> = ["result", "failure"]
    static let coveredPenalty = 6
    static let readPenalty = 10

    // 只合并 progress/decision：较旧的帖子折入同 `${sessionId ?? taskId}:${kind}` 键的
    // 最新帖子（时间差不超过 6h，含边界），highlights 去重后保留前 2 条。比较始终针对
    // 该键的最新帖子，合并链不会延长窗口。输入按 createdAt 降序稳定排序。
    static func mergeRoutinePosts(_ posts: [FeedPost]) -> [FeedPost] {
        var merged: [FeedPost] = []
        var latestIndex: [String: Int] = [:]
        for post in stableSortedByCreatedAtDesc(posts) {
            guard routineKinds.contains(post.kind) else {
                merged.append(post)
                continue
            }
            let key = "\(post.sessionId ?? post.taskId):\(post.kind)"
            if let index = latestIndex[key],
               merged[index].createdAt.zimloDate.timeIntervalSince(post.createdAt.zimloDate) <= mergeWindow {
                merged[index].highlights = dedupedHighlights(merged[index].highlights + post.highlights)
            } else {
                latestIndex[key] = merged.count
                merged.append(post)
            }
        }
        return merged
    }

    static func dedupedHighlights(_ highlights: [String]) -> [String] {
        var seen = Set<String>()
        var result: [String] = []
        for highlight in highlights where seen.insert(highlight).inserted {
            result.append(highlight)
        }
        return Array(result.prefix(2))
    }

    // 任务最新的 result/failure 严格新于帖子时间时，可覆盖类帖子视为已被覆盖。
    static func isCovered(kind: String, createdAt: String, latestOutcomeCreatedAt: String?) -> Bool {
        coverableKinds.contains(kind) && (latestOutcomeCreatedAt ?? "") > createdAt
    }

    static func priority(kind: String, needsAction: Bool, covered: Bool, unread: Bool) -> Int {
        if needsAction { return 0 }
        return (postValue[kind] ?? 5) + (covered ? coveredPenalty : 0) + (unread ? 0 : readPenalty)
    }

    // priority 升序，然后 createdAt 降序；两键全等保持输入顺序（Swift 排序不稳定，
    // 用下标 tiebreak，与 TS 的 stable sort 对齐）。
    static func stableSorted<T: FeedOrderable>(_ items: [T]) -> [T] {
        items.enumerated()
            .sorted { left, right in
                if left.element.priority != right.element.priority { return left.element.priority < right.element.priority }
                if left.element.createdAt != right.element.createdAt { return left.element.createdAt > right.element.createdAt }
                return left.offset < right.offset
            }
            .map(\.element)
    }

    static func stableSortedByCreatedAtDesc(_ posts: [FeedPost]) -> [FeedPost] {
        posts.enumerated()
            .sorted { left, right in
                left.element.createdAt == right.element.createdAt
                    ? left.offset < right.offset
                    : left.element.createdAt > right.element.createdAt
            }
            .map(\.element)
    }
}

protocol FeedOrderable {
    var priority: Int { get }
    var createdAt: String { get }
}

// MARK: - Outbox 语义键

enum SemanticKey {
    static func make(_ command: ClientCommand) -> String {
        func field(_ key: String) -> String {
            guard case .string(let value) = command.values[key] else { return "" }
            return value.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        switch command.type {
        case "task.create":
            return "\(command.type):\(field("provider")):\(field("workspaceId")):\(field("text"))"
        case "task.follow_up", "session.message":
            return "\(command.type):\(field("sessionId")):\(field("text"))"
        case "task.command.retry":
            return "\(command.type):\(field("commandId"))"
        case "task.command.cancel":
            let target = field("commandId").isEmpty ? field("idempotencyKey") : field("commandId")
            return "\(command.type):\(target)"
        case "action.decide":
            return "\(command.type):\(field("actionId")):\(field("decisionId")):\(field("confirmationPhrase")):\(sortedInput(command.values["input"]))"
        case "feed.dismiss", "feed.dismiss.set":
            return "\(command.type):\(field("itemId"))"
        case "feed.seen":
            return "\(command.type):\(field("postId"))"
        case "task.timeline.seen":
            return "\(command.type):\(field("sessionId")):\(field("itemId"))"
        case "agent.profile.update", "trust.policy.update":
            return "\(command.type):\(field("projectId"))"
        case "user.profile.update", "notification.settings.update",
             "notification.device.register", "notification.device.unregister":
            return command.type
        default:
            // 未知类型：递归按 key 码元序排序的确定性 JSON（不含 type，已在键前缀中）。
            var fields = command.values
            fields.removeValue(forKey: "type")
            return "\(command.type):\(stableStringify(.object(fields)))"
        }
    }

    // action.decide 的 input 记录：只取字符串值，按 key 码元序排列成 JSON 对数组。
    private static func sortedInput(_ input: JSONValue?) -> String {
        guard case .object(let object) = input else { return "[]" }
        let entries = object
            .compactMap { key, value -> (String, String)? in
                guard case .string(let text) = value else { return nil }
                return (key, text)
            }
            .sorted { $0.0 < $1.0 }
        return "[" + entries.map { "[\(jsonEscape($0.0)),\(jsonEscape($0.1))]" }.joined(separator: ",") + "]"
    }

    static func stableStringify(_ value: JSONValue) -> String {
        switch value {
        case .string(let text): return jsonEscape(text)
        case .number(let number):
            if number == number.rounded(), abs(number) < 9_007_199_254_740_992 {
                return String(Int64(number))
            }
            return String(number)
        case .bool(let flag): return flag ? "true" : "false"
        case .null: return "null"
        case .array(let items):
            return "[" + items.map(stableStringify).joined(separator: ",") + "]"
        case .object(let object):
            let body = object.keys.sorted().map { key in
                "\(jsonEscape(key)):\(stableStringify(object[key] ?? .null))"
            }
            return "{" + body.joined(separator: ",") + "}"
        }
    }

    // 与 JSON.stringify 一致的最小转义：引号、反斜杠与 <0x20 控制字符。
    static func jsonEscape(_ text: String) -> String {
        var result = "\""
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": result += "\\\""
            case "\\": result += "\\\\"
            case "\u{08}": result += "\\b"
            case "\u{09}": result += "\\t"
            case "\u{0A}": result += "\\n"
            case "\u{0C}": result += "\\f"
            case "\u{0D}": result += "\\r"
            case let s where s.value < 0x20: result += String(format: "\\u%04x", s.value)
            default: result.unicodeScalars.append(scalar)
            }
        }
        return result + "\""
    }
}

// MARK: - 撤回状态

enum CommandCancelRules {
    static let cancelableStates: Set<String> = ["queued"]
    static func isCancelable(_ state: String) -> Bool { cancelableStates.contains(state) }

    // 仅本地排队或服务端仍处于 queued 的 create/follow-up 可撤回；审批、设备、设置类只展示。
    static func isOutboxEntryCancelable(_ entry: OutboxEntry, snapshot: Snapshot) -> Bool {
        guard ["task.create", "task.follow_up", "session.message"].contains(entry.command.type) else { return false }
        let key = entry.command.idempotencyKey ?? entry.id
        guard let server = snapshot.commands.first(where: {
            $0.idempotencyKey == key || $0.idempotencyKey.hasSuffix(":\(key)")
        }) else { return true }
        return isCancelable(server.state)
    }
}

// Feed 页面会话固定序列：已进入当前队列的卡保持原位；只有显式消失才移除，
// 新卡或重新变成待处理的历史卡追加到末尾。
enum FeedCohortRules {
    static let caughtUpID = "caught-up"

    static func signature(_ entries: [FeedEntry]) -> [String] {
        entries.map { "\($0.id):\($0.unread):\($0.needsAction)" }
    }

    static func reconcile(previous: [String], entries: [FeedEntry]) -> [String] {
        let existing = Set(entries.map(\.id))
        var order = previous.filter(existing.contains)
        var included = Set(order)
        for entry in entries where entry.unread || entry.needsAction {
            if included.insert(entry.id).inserted { order.append(entry.id) }
        }
        return order
    }

    // 用户已经翻到「已清空」时，新到达的卡就是下一条注意力，不应继续藏在
    // 空状态上方。阅读任意真实卡片时则返回 nil，保持原有锚点不跳动。
    static func arrivalTarget(
        visibleID: String?,
        previous: [String],
        next: [String],
        entries: [FeedEntry]
    ) -> String? {
        guard visibleID == caughtUpID else { return nil }
        let previousIDs = Set(previous)
        let added = next.filter { !previousIDs.contains($0) }
        guard !added.isEmpty else { return nil }
        let byID = Dictionary(uniqueKeysWithValues: entries.map { ($0.id, $0) })
        return added.first(where: { byID[$0]?.needsAction == true }) ?? added.first
    }
}

// MARK: - 重连退避

enum ReconnectBackoff {
    static let delaysMs: [Double] = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]
    static let jitterRatio = 0.2

    // attempt 0 是第一次重试；超出序列钳制到最后一档；±20% 对称抖动，随机源可注入。
    static func delayMs(attempt: Double, random: () -> Double = { Double.random(in: 0..<1) }) -> Int {
        let index = min(max(Int(attempt.rounded(.towardZero)), 0), delaysMs.count - 1)
        let base = delaysMs[index]
        return Int((base * (1 + (random() * 2 - 1) * jitterRatio)).rounded(.toNearestOrAwayFromZero))
    }
}

enum BridgeConnectionLeaseRules {
    static func accepts(
        expectedGeneration: UInt64,
        currentGeneration: UInt64,
        intentionallyStopped: Bool
    ) -> Bool {
        !intentionallyStopped && expectedGeneration == currentGeneration
    }
}

// MARK: - 高风险审批双确认状态机

// 先「填入确认短语」（第一次明确操作），再「确认执行」（第二次明确操作）。短语由
// 按钮自动填入而不是手敲——短语的价值在于证明人读过，不在于打字能力，所以不使用
// Face ID。取消或审批过期都会清空短语，回到 needsFill。
struct HighRiskApprovalState: Equatable {
    enum Phase: Equatable {
        case needsFill
        case readyToSubmit
        case submitted
    }

    let requiredPhrase: String
    private(set) var phase: Phase = .needsFill
    private(set) var filledPhrase: String?

    var canSubmit: Bool { phase == .readyToSubmit && filledPhrase == requiredPhrase }

    mutating func fillPhrase() {
        guard phase == .needsFill else { return }
        filledPhrase = requiredPhrase
        phase = .readyToSubmit
    }

    // 提交成功返回要发送的短语；未经过 fillPhrase 时返回 nil，保证两步缺一不可。
    mutating func submit() -> String? {
        guard canSubmit else { return nil }
        phase = .submitted
        return filledPhrase
    }

    mutating func reset() {
        guard phase != .submitted else { return }
        filledPhrase = nil
        phase = .needsFill
    }
}

// MARK: - 快捷审批

enum QuickApproveRules {
    // 仅 approval 类、存在低风险 allow-once 与 deny 两个决定、且都不要求确认短语时，
    // 才允许通知或卡片上一键批准。
    static func isQuickApprovable(kind: String, decisions: [Decision]) -> Bool {
        guard kind == "approval" else { return false }
        let allowOnce = decisions.first { $0.scope == "once" }
        let deny = decisions.first { $0.scope == "deny" }
        return allowOnce?.risk == "low"
            && (allowOnce?.confirmationPhrase ?? "").isEmpty
            && deny != nil
            && (deny?.confirmationPhrase ?? "").isEmpty
    }
}
