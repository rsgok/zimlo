import Foundation

enum NativeFeedEntry: Hashable, Identifiable {
    case post(FeedPost)
    case action(PendingAction)
    case command(TaskCommand)

    var id: String {
        switch self {
        case .post(let value): "post:\(value.id)"
        case .action(let value): "action:\(value.id)"
        case .command(let value): "command:\(value.id)"
        }
    }
    var createdAt: String {
        switch self {
        case .post(let value): value.createdAt
        case .action(let value): value.createdAt
        case .command(let value): value.createdAt
        }
    }
}

enum NativeFeedPolicy {
    static func candidates(_ snapshot: NativeSnapshot, now: Date = Date()) -> [NativeFeedEntry] {
        let dismissed = Set(snapshot.dismissedFeedItemIds)
        let seen = Set(snapshot.seenPostIds)
        var posts: [FeedPost] = []
        var latestByTask: [String: Int] = [:]
        for post in snapshot.posts.sorted(by: { $0.createdAt > $1.createdAt }) {
            let key = "\(post.sessionId ?? post.taskId):\(post.kind)"
            if ["progress", "decision"].contains(post.kind) {
                if let index = latestByTask[key],
                   posts[index].createdAt.zimloDate.timeIntervalSince(post.createdAt.zimloDate) <= 6 * 3600 {
                    var highlights = posts[index].highlights
                    highlights += post.highlights.filter { !highlights.contains($0) }
                    posts[index].highlights = Array(highlights.prefix(2))
                    continue
                }
                latestByTask[key] = posts.count
            }
            posts.append(post)
        }
        let outcomes = Dictionary(grouping: snapshot.posts.filter { ["result", "failure"].contains($0.kind) }) { $0.sessionId ?? $0.taskId }
            .mapValues { $0.map(\.createdAt).max() ?? "" }
        var entries = posts.map(NativeFeedEntry.post)
        entries += snapshot.actions.filter { $0.state == "pending" && $0.expiresAt.zimloDate > now }.map(NativeFeedEntry.action)
        entries += snapshot.commands.filter {
            $0.kind == "create" && $0.sessionId == nil && ["queued", "dispatching", "running", "failed"].contains($0.state)
        }.map(NativeFeedEntry.command)
        func priority(_ entry: NativeFeedEntry) -> Int {
            switch entry {
            case .action: return 0
            case .command(let command): return command.state == "failed" ? 0 : 5
            case .post(let post):
                let covered = ["progress", "decision", "attention"].contains(post.kind)
                    && (outcomes[post.sessionId ?? post.taskId] ?? "") > post.createdAt
                return (["failure": 1, "result": 2, "decision": 3, "attention": 3, "progress": 4][post.kind] ?? 4)
                    + (covered ? 6 : 0) + (seen.contains(post.id) ? 10 : 0)
            }
        }
        return entries.filter { entry in
            if case .post(let post) = entry, dismissed.contains(post.id) { return false } // legacy Mac keys
            return !dismissed.contains(entry.id)
        }.sorted {
            if priority($0) != priority($1) { return priority($0) < priority($1) }
            if $0.createdAt != $1.createdAt { return $0.createdAt > $1.createdAt }
            return $0.id < $1.id
        }
    }
}

struct NativeFeedSequence: Equatable {
    private(set) var entries: [NativeFeedEntry] = []
    private(set) var fresh: [String] = []
    private var hostID: String?

    mutating func reconcile(_ snapshot: NativeSnapshot, now: Date = Date()) {
        if hostID != snapshot.host?.id {
            entries = []; fresh = []; hostID = snapshot.host?.id
        }
        let incoming = NativeFeedPolicy.candidates(snapshot, now: now)
        let byID = Dictionary(uniqueKeysWithValues: incoming.map { ($0.id, $0) })
        let dismissed = Set(snapshot.dismissedFeedItemIds)
        let hadEntries = !entries.isEmpty
        entries = entries.compactMap { previous in
            if dismissed.contains(previous.id) { return nil }
            if let updated = byID[previous.id] { return updated }
            switch previous {
            case .post(let post):
                guard !dismissed.contains(post.id), let updated = snapshot.posts.first(where: { $0.id == post.id }) else { return nil }
                return .post(updated)
            case .action(var action):
                action = snapshot.actions.first(where: { $0.id == action.id }) ?? action
                if action.state == "pending" { action.state = "settled" }
                return .action(action)
            case .command(let command):
                if command.id.hasPrefix("local:"), !snapshot.commands.contains(where: { $0.id == command.id }) { return nil }
                return .command(snapshot.commands.first(where: { $0.id == command.id }) ?? command)
            }
        }
        let existing = Set(entries.map(\.id))
        let newcomers = incoming.filter { !existing.contains($0.id) }
        entries.insert(contentsOf: newcomers, at: 0)
        let ids = Set(entries.map(\.id))
        fresh = fresh.filter { ids.contains($0) }
        if hadEntries { fresh.insert(contentsOf: newcomers.map(\.id), at: 0) }
    }

    mutating func clearFresh() { fresh = [] }
}
