import Combine
import Foundation
import ZimloCore

struct NativeOutboxEntry: Codable, Hashable, Identifiable {
    enum State: String, Codable { case queued, sent, failed }
    var id: String
    var hostID: String
    var command: ClientCommand
    var createdAt: Date
    var state: State = .queued
    var attempts = 0
    var retryAt: Date = .distantPast
    var error: String?

    var preview: String { command.values["text"]?.stringValue ?? "" }
    var sessionID: String? { command.values["sessionId"]?.stringValue }
    var canWithdrawLocally: Bool { state == .queued && attempts == 0 }
    var stateLabel: String {
        switch state {
        case .queued: "已保存，等待发送"
        case .sent: "正在确认设备是否收到"
        case .failed: "需要处理"
        }
    }
}

struct NativeOutboxStorage {
    var read: () throws -> [NativeOutboxEntry]
    var write: ([NativeOutboxEntry]) throws -> Void

    static func file(at url: URL) -> Self {
        Self(read: {
            guard FileManager.default.fileExists(atPath: url.path) else { return [] }
            return try JSONDecoder().decode([NativeOutboxEntry].self, from: Data(contentsOf: url))
        }, write: { entries in
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            try JSONEncoder().encode(entries).write(to: url, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        })
    }

    static var live: Self {
        if let root = ProcessInfo.processInfo.environment["ZIMLO_HOME"] {
            return .file(at: URL(fileURLWithPath: root).appending(path: "macos/commands/outbox-v1.json"))
        }
        let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appending(path: "Zimlo/Commands", directoryHint: .isDirectory)
        return .file(at: folder.appending(path: "outbox-v1.json"))
    }
}

/// Persist every transition before exposing it. A lost response remains an
/// unknown outcome and retries keep the ORIGINAL command/idempotency key.
@MainActor
final class NativeCommandOutbox: ObservableObject {
    @Published private(set) var entries: [NativeOutboxEntry] = []
    @Published private(set) var storageIssue: String?
    private let storage: NativeOutboxStorage
    private let metrics: ExperienceMetrics?
    private var flushing = false
    private var loadFailed = false

    init(storage: NativeOutboxStorage = .live, metrics: ExperienceMetrics? = nil) {
        self.metrics = metrics
        self.storage = storage
        do { entries = try storage.read() }
        catch {
            loadFailed = true
            storageIssue = "待发送记录无法读取，原文件已保留。请检查本机存储后重新打开应用。"
        }
    }

    @discardableResult
    func enqueue(_ command: ClientCommand, hostID: String, now: Date = Date()) -> Bool {
        guard !hostID.isEmpty, let key = command.values["idempotencyKey"]?.stringValue else { return false }
        let id = "\(hostID):\(key)"
        if entries.contains(where: { $0.id == id }) { return true }
        var routed = command
        routed.values["hostId"] = .string(hostID)
        let saved = persist(entries + [.init(id: id, hostID: hostID, command: routed, createdAt: now)])
        if saved { metrics?.record(.commandSaved) }
        return saved
    }

    @discardableResult
    func withdraw(_ id: String) -> Bool {
        guard let entry = entries.first(where: { $0.id == id }), entry.canWithdrawLocally else { return false }
        return persist(entries.filter { $0.id != id })
    }

    @discardableResult
    func discardFailure(_ id: String) -> Bool {
        guard entries.contains(where: { $0.id == id && $0.state == .failed }) else { return false }
        return persist(entries.filter { $0.id != id })
    }

    func retry(_ id: String) {
        _ = update(id) { entry in
            entry.state = entry.attempts == 0 ? .queued : .sent
            entry.retryAt = .distantPast
            entry.error = nil
        }
    }

    func flush(
        snapshot: NativeSnapshot,
        now: Date = Date(),
        send: @MainActor (ClientCommand) async throws -> LocalCommandResponse,
        received: (LocalCommandResponse) -> Void
    ) async {
        guard !flushing, !loadFailed, let host = snapshot.host?.id else { return }
        flushing = true
        defer { flushing = false }
        // A persisted server command is already an authoritative receipt,
        // including when the original HTTP response never reached this App.
        let acknowledged = Set(snapshot.commands.filter { $0.hostId == nil || $0.hostId == host }.map(\.idempotencyKey))
        let remaining = entries.filter { entry in
            entry.hostID != host || !acknowledged.contains(where: { key in
                let original = entry.command.values["idempotencyKey"]?.stringValue ?? ""
                return key == original || key.hasSuffix(":" + original)
            })
        }
        let confirmed = entries.filter { entry in !remaining.contains(where: { $0.id == entry.id }) }
        guard remaining == entries || persist(remaining) else { return }
        for entry in confirmed { metrics?.record(.commandReceived, milliseconds: max(0, now.timeIntervalSince(entry.createdAt) * 1000)) }
        for id in entries.map(\.id) {
            guard let entry = entries.first(where: { $0.id == id }),
                  entry.hostID == host, entry.state != .failed, entry.retryAt <= now else { continue }
            guard update(id, { value in
                value.state = .sent
                value.attempts += 1
                value.retryAt = now.addingTimeInterval(min(30, pow(2, Double(min(value.attempts, 5)))))
            }) else { return }
            do {
                let response = try await send(entry.command)
                guard response.snapshot.host?.id == host else { throw LocalServiceIdentityError.mismatch }
                if let issue = response.messages.first(where: { $0.type == "error" || $0.ok == false }) {
                    _ = update(id) { value in
                        value.state = .failed
                        value.error = issue.message ?? "设备拒绝了这个操作，可以重新编辑或重试。"
                    }
                } else if response.ok {
                    if persist(entries.filter { $0.id != id }) { metrics?.record(.commandReceived, milliseconds: max(0, Date().timeIntervalSince(entry.createdAt) * 1000)) }
                } else {
                    _ = update(id) { value in
                        value.state = .failed
                        value.error = "设备没有接受操作，请查看任务状态。"
                    }
                }
                received(response)
            } catch let error as BridgeAPIError {
                _ = update(id) { value in
                    value.error = error.localizedDescription
                    // Explicit validation/authorization errors are terminal;
                    // transport/server outages retain an unknown receipt.
                    if error.recoverable == false { value.state = .failed }
                }
            } catch {
                _ = update(id) { $0.error = error.localizedDescription }
                // A broken connection affects the rest of the batch too.
                return
            }
        }
    }

    @discardableResult
    private func update(_ id: String, _ change: (inout NativeOutboxEntry) -> Void) -> Bool {
        var next = entries
        guard let index = next.firstIndex(where: { $0.id == id }) else { return false }
        let wasFailed = next[index].state == .failed
        change(&next[index])
        let newFailure = !wasFailed && next[index].state == .failed
        let saved = persist(next)
        if saved && newFailure { metrics?.record(.commandFailed) }
        return saved
    }

    private func persist(_ next: [NativeOutboxEntry]) -> Bool {
        guard !loadFailed else { return false }
        do {
            try storage.write(next)
            entries = next
            storageIssue = nil
            return true
        } catch {
            storageIssue = "无法保存待发送操作，请检查磁盘空间；输入内容仍会保留。"
            return false
        }
    }
}
