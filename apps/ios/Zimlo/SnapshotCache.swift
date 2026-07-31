import Foundation

// 磁盘缓存格式：{ snapshot, savedAt }。savedAt 让离线 UI 能告诉用户数据多旧。
// 旧版本写入的是裸 Snapshot JSON，读取时按文件修改时间迁移。
struct CachedSnapshot: Codable {
    var snapshot: Snapshot
    var savedAt: Date
}

/// Serializes cache IO away from MainActor and preserves write ordering when a
/// burst of WebSocket messages arrives.
actor SnapshotWriter {
    func save(_ snapshot: Snapshot) -> Date? { SnapshotCache.save(snapshot) }
    func clear() { SnapshotCache.clear() }
}

enum SnapshotCache {
    private static var fileURL: URL? {
        guard let directory = try? FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        ) else { return nil }
        let folder = directory.appending(path: "Zimlo", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(
            at: folder,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
        return folder.appending(path: "last-snapshot.json")
    }

    static func load() -> Snapshot? { loadEnvelope()?.snapshot }

    static func loadEnvelope() -> CachedSnapshot? {
        guard let fileURL, let data = try? Data(contentsOf: fileURL) else { return nil }
        let modifiedAt = (try? FileManager.default.attributesOfItem(atPath: fileURL.path))?[.modificationDate] as? Date
        return decode(data, fileModifiedAt: modifiedAt)
    }

    static func decode(_ data: Data, fileModifiedAt: Date? = nil) -> CachedSnapshot? {
        if let envelope = try? JSONDecoder().decode(CachedSnapshot.self, from: data) {
            return envelope
        }
        if let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data) {
            return CachedSnapshot(snapshot: snapshot, savedAt: fileModifiedAt ?? .distantPast)
        }
        return nil
    }

    @discardableResult
    static func save(_ snapshot: Snapshot) -> Date? {
        let savedAt = Date()
        guard let fileURL,
              let data = try? JSONEncoder().encode(CachedSnapshot(snapshot: snapshot, savedAt: savedAt)) else { return nil }
        do {
            try data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            return savedAt
        } catch {
            // The live snapshot remains available; cache failure must not
            // interrupt approvals or command delivery.
            return nil
        }
    }

    static func clear() {
        guard let fileURL else { return }
        try? FileManager.default.removeItem(at: fileURL)
    }
}
