import Foundation

/// A transport-owned baseline, separate from optimistic UI mutations. A gap
/// always requests a full snapshot; it never patches another host's state.
public struct SnapshotReplica {
    public enum Outcome { case message(Data, negotiateDelta: Bool), resync }
    private var snapshot: [String: Any]?
    private var revision: String?
    private var negotiated = false
    public init() {}

    public mutating func receive(_ data: Data, hostID: String) -> Outcome {
        guard let envelope = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let type = envelope["type"] as? String else { return .resync }
        if type == "session.snapshot" {
            guard let next = envelope["snapshot"] as? [String: Any],
                  (next["host"] as? [String: Any])?["id"] as? String == hostID else { return .resync }
            snapshot = next; revision = envelope["revision"] as? String
            let enable = !negotiated && (envelope["syncCapabilities"] as? [String: Bool])?["delta"] == true
            negotiated = negotiated || enable
            return .message(data, negotiateDelta: enable)
        }
        guard type == "snapshot.delta" else { return .message(data, negotiateDelta: false) }
        guard var next = snapshot, let revision,
              envelope["hostId"] as? String == hostID,
              envelope["baseRevision"] as? String == revision,
              let nextRevision = envelope["revision"] as? String, nextRevision != revision,
              let replace = envelope["replace"] as? [String: Any],
              let collections = envelope["collections"] as? [String: [String: Any]],
              let removed = envelope["removedFields"] as? [String] else { return .resync }
        for key in removed { next.removeValue(forKey: key) }
        for (key, value) in replace { next[key] = value }
        for (name, patch) in collections {
            guard let key = Self.keys[name], patch["key"] as? String == key,
                  let old = next[name] as? [[String: Any]],
                  let upsert = patch["upsert"] as? [[String: Any]],
                  let remove = patch["remove"] as? [String], let order = patch["order"] as? [String],
                  Set(order).count == order.count else { return .resync }
            var items: [String: [String: Any]] = [:]
            for item in old { guard let id = item[key] as? String else { return .resync }; items[id] = item }
            for id in remove { items.removeValue(forKey: id) }
            for item in upsert { guard let id = item[key] as? String else { return .resync }; items[id] = item }
            guard items.count == order.count, order.allSatisfy({ items[$0] != nil }) else { return .resync }
            next[name] = order.compactMap { items[$0] }
        }
        guard (next["host"] as? [String: Any])?["id"] as? String == hostID,
              let result = try? JSONSerialization.data(withJSONObject: ["type":"session.snapshot", "snapshot":next]) else { return .resync }
        snapshot = next; self.revision = nextRevision
        return .message(result, negotiateDelta: false)
    }

    private static let keys = ["projects":"id", "sessions":"id", "posts":"id", "materials":"id", "tasks":"id",
        "commands":"id", "workspaces":"id", "cards":"id", "actions":"actionId", "taskPreferences":"sessionId"]
}
