import AppKit
import Combine
import CryptoKit
import Foundation
import ZimloCore
import UniformTypeIdentifiers

struct LocalBridgeRoute: Equatable {
    static let defaultPort = 4747
    let baseURL: URL

    static func resolve(descriptor: ServiceDescriptor?) -> LocalBridgeRoute {
        let port: Int
        if let descriptor,
           HealthCheck.isCompatible(protocolVersion: descriptor.protocolVersion),
           (1...65_535).contains(descriptor.port) {
            port = descriptor.port
        } else {
            port = defaultPort
        }
        return LocalBridgeRoute(baseURL: URL(string: "http://127.0.0.1:\(port)")!)
    }
}

struct NativeBridgeClient: Sendable {
    var fetchSnapshot: @Sendable () async throws -> NativeSnapshot
    var fetchEvents: @Sendable (_ sessionID: String) async throws -> [UnifiedEvent]
    var send: @Sendable (_ command: ClientCommand) async throws -> LocalCommandResponse
    var importMaterial: @Sendable (_ fileURL: URL) async throws -> Material
    var materialURL: @Sendable (_ materialID: String) -> URL

    static func live(baseURL: URL) -> NativeBridgeClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 12
        configuration.timeoutIntervalForResource = 60
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: configuration)
        let decoder = JSONDecoder()
        let snapshots = NativeSnapshotRepository()

        @Sendable func checkedData(for request: URLRequest) async throws -> Data {
            let (data, response) = try await LocalServiceConnection().data(for: request, using: session)
            guard let http = response as? HTTPURLResponse else {
                throw URLError(.badServerResponse)
            }
            guard (200..<300).contains(http.statusCode) else {
                if let issue = try? decoder.decode(BridgeAPIError.self, from: data) { throw issue }
                throw BridgeAPIError(code: "http_\(http.statusCode)", message: "本地服务没有完成这个操作。", recoverable: true)
            }
            return data
        }

        return NativeBridgeClient(
            fetchSnapshot: {
                try await snapshots.fetch(baseURL: baseURL, session: session)
            },
            fetchEvents: { sessionID in
                let safeID = sessionID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionID
                let request = URLRequest(url: baseURL.appending(path: "api/local/sessions/\(safeID)/events"))
                return try decoder.decode(LocalEventsResponse.self, from: await checkedData(for: request)).events
            },
            send: { command in
                var request = URLRequest(url: baseURL.appending(path: "api/local/commands"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try JSONEncoder().encode(command)
                request.setValue(command.values["hostId"]?.stringValue, forHTTPHeaderField: "X-Zimlo-Host-ID")
                return try decoder.decode(LocalCommandResponse.self, from: await checkedData(for: request))
            },
            importMaterial: { fileURL in
                let scoped = fileURL.startAccessingSecurityScopedResource()
                defer { if scoped { fileURL.stopAccessingSecurityScopedResource() } }
                let data = try Data(contentsOf: fileURL, options: .mappedIfSafe)
                guard !data.isEmpty else {
                    throw BridgeAPIError(code: "empty_file", message: "文件内容为空。", recoverable: false)
                }
                let metadata = try NativeMaterialPolicy.metadata(for: fileURL, data: data)
                let materialID = "material_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
                var request = URLRequest(url: baseURL.appending(path: "api/local/materials/\(materialID)"))
                request.httpMethod = "PUT"
                request.timeoutInterval = 60
                request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
                request.setValue(metadata.kind, forHTTPHeaderField: "X-Zimlo-Kind")
                request.setValue(metadata.mimeType, forHTTPHeaderField: "X-Zimlo-Mime")
                request.setValue(metadata.name.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed), forHTTPHeaderField: "X-Zimlo-Name")
                request.setValue(SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(), forHTTPHeaderField: "X-Zimlo-Sha256")
                request.httpBody = data
                return try decoder.decode(Material.self, from: await checkedData(for: request))
            },
            materialURL: { materialID in
                baseURL.appending(path: "api/materials/\(materialID)/content")
            }
        )
    }
}

private enum NativeMaterialPolicy {
    struct Metadata {
        var kind: String
        var mimeType: String
        var name: String
    }

    static func metadata(for url: URL, data: Data) throws -> Metadata {
        let name = String(url.lastPathComponent.prefix(180))
        let type = (try? url.resourceValues(forKeys: [.contentTypeKey]).contentType)
            ?? UTType(filenameExtension: url.pathExtension)
        let mime = type?.preferredMIMEType ?? "application/octet-stream"
        let kind: String
        let limit: Int
        if type?.conforms(to: .image) == true {
            kind = "image"; limit = 8 * 1_024 * 1_024
        } else if type?.conforms(to: .movie) == true {
            kind = "video"; limit = 50 * 1_024 * 1_024
        } else if type?.conforms(to: .pdf) == true {
            kind = "pdf"; limit = 20 * 1_024 * 1_024
        } else if type?.conforms(to: .text) == true
                    || type?.conforms(to: .spreadsheet) == true
                    || type?.conforms(to: .presentation) == true
                    || ["doc", "docx", "xls", "xlsx", "ppt", "pptx", "md", "csv", "json"]
                        .contains(url.pathExtension.lowercased()) {
            kind = "document"; limit = 15 * 1_024 * 1_024
        } else {
            throw BridgeAPIError(code: "unsupported_file", message: "暂不支持这种文件格式。", recoverable: false)
        }
        guard data.count <= limit else {
            throw BridgeAPIError(code: "file_too_large", message: "这个文件超过 \(limit / 1_024 / 1_024)MB 限制。", recoverable: false)
        }
        return Metadata(kind: kind, mimeType: mime, name: name)
    }
}

enum NativeLoadState: Equatable {
    case idle
    case loading
    case loaded
    case failed(String)
}

enum NativeNoticeTone {
    case neutral
    case success
    case failure
}

struct NativeNotice: Identifiable, Equatable {
    let id = UUID()
    var text: String
    var tone: NativeNoticeTone
}

@MainActor
final class NativeAppStore: ObservableObject {
    @Published private(set) var snapshot = NativeSnapshot.empty
    @Published private(set) var devices: [NativeDevice] = []
    @Published private(set) var loadState: NativeLoadState = .idle
    @Published private(set) var eventsBySession: [String: [UnifiedEvent]] = [:]
    @Published private(set) var importingFiles = false
    @Published var notice: NativeNotice?

    private let client: NativeBridgeClient
    private let notifications: MacNotificationManager
    private var refreshInFlight = false
    private var refreshFailures = 0
    private var measuredFirstSnapshot = false
    let metrics: ExperienceMetrics?
    let outbox: NativeCommandOutbox
    private var outboxObserver: AnyCancellable?

    init(client: NativeBridgeClient, notifications: MacNotificationManager = .shared, outbox: NativeCommandOutbox? = nil, metrics: ExperienceMetrics? = nil) {
        self.metrics = metrics
        self.client = client
        self.notifications = notifications
        self.outbox = outbox ?? NativeCommandOutbox(metrics: metrics)
        outboxObserver = self.outbox.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
    }

    func run() async {
        if loadState == .idle { loadState = .loading }
        while !Task.isCancelled {
            await refresh()
            let interval = NativeRefreshPolicy.interval(active: NSApp?.isActive == true, hasWork: !outbox.entries.isEmpty || snapshot.sessions.contains { $0.status == "running" }, failures: refreshFailures)
            do { try await Task.sleep(for: .seconds(interval)) }
            catch { return }
        }
    }

    func refresh() async {
        guard !refreshInFlight else { return }
        refreshInFlight = true
        let started = ContinuousClock.now
        defer { refreshInFlight = false }
        do {
            let next = try await client.fetchSnapshot()
            refreshFailures = 0
            let elapsed = started.duration(to: .now).components
            let milliseconds = Double(elapsed.seconds) * 1000 + Double(elapsed.attoseconds) / 1e15
            if !measuredFirstSnapshot { metrics?.record(.firstSnapshot, milliseconds: milliseconds); measuredFirstSnapshot = true }
            else { metrics?.record(.snapshotRefresh, milliseconds: milliseconds) }
            if next.host?.id != snapshot.host?.id || next.sequence >= snapshot.sequence {
                if next.host?.id != snapshot.host?.id { eventsBySession = [:] }
                let previous = snapshot
                let shouldNotify = loadState == .loaded && next.sequence > previous.sequence
                if snapshot != next { snapshot = next }
                if shouldNotify {
                    await notifications.process(previous: previous, next: next)
                } else {
                    notifications.updateBadge(next)
                }
            }
            if loadState != .loaded { loadState = .loaded }
            await flushOutbox()
        } catch let error as LocalServiceIdentityError {
            refreshFailures += 1
            loadState = .failed(error.localizedDescription)
        } catch is CancellationError {
            return
        } catch {
            refreshFailures += 1
            if snapshot.sequence == 0 { loadState = .failed(error.localizedDescription) }
        }
    }

    @discardableResult
    func send(_ command: ClientCommand, notice successText: String? = nil) async -> Bool {
        do {
            var routed = command
            if routed.values["hostId"] == nil, let host = snapshot.host?.id { routed.values["hostId"] = .string(host) }
            let response = try await client.send(routed)
            if let expected = routed.values["hostId"]?.stringValue, response.snapshot.host?.id != expected {
                throw LocalServiceIdentityError.mismatch
            }
            snapshot = response.snapshot
            notifications.updateBadge(response.snapshot)
            if let nextDevices = response.messages.first(where: { $0.type == "devices.list" })?.devices {
                devices = nextDevices.filter(\.isActivePhone).sorted { $0.lastSeenAt > $1.lastSeenAt }
            }
            if let error = response.messages.first(where: { $0.type == "error" || $0.ok == false }) {
                throw BridgeAPIError(
                    code: error.code ?? "command_failed",
                    message: error.message ?? "操作未完成。",
                    recoverable: true
                )
            }
            guard response.ok else {
                throw BridgeAPIError(code: "command_failed", message: "设备没有接受这个操作。", recoverable: true)
            }
            if let successText { showNotice(successText, tone: .success) }
            return true
        } catch {
            showNotice(error.localizedDescription, tone: .failure)
            return false
        }
    }

    func loadDevices() async {
        _ = await send(ClientCommand(type: "devices.request"))
    }

    func revokeDevice(_ device: NativeDevice) async -> Bool {
        await send(
            ClientCommand(type: "device.revoke", ["deviceId": .string(device.id)]),
            notice: "已移除 \(device.name)"
        )
    }

    func loadEvents(sessionID: String) async {
        do {
            eventsBySession[sessionID] = try await client.fetchEvents(sessionID)
        } catch {
            showNotice(error.localizedDescription, tone: .failure)
        }
    }

    func createTask(text: String, provider: Provider, workspaceID: String, materialIDs: [String]) async -> Bool {
        enqueueTask(ClientCommand(type: "task.create", [
            "provider": .string(provider.rawValue),
            "workspaceId": .string(workspaceID),
            "text": .string(text),
            "materialIds": .array(materialIDs.map(JSONValue.string)),
            "idempotencyKey": .string(UUID().uuidString),
        ]))
    }

    func followUp(sessionID: String, text: String, materialIDs: [String]) async -> Bool {
        enqueueTask(ClientCommand(type: "task.follow_up", [
            "sessionId": .string(sessionID),
            "text": .string(text),
            "materialIds": .array(materialIDs.map(JSONValue.string)),
            "idempotencyKey": .string(UUID().uuidString),
        ]))
    }

    var displayedCommands: [TaskCommand] {
        let pending = outbox.entries.filter { entry in
            entry.hostID == snapshot.host?.id && !snapshot.commands.contains { command in
                let key = entry.command.values["idempotencyKey"]?.stringValue ?? ""
                return command.idempotencyKey == key || command.idempotencyKey.hasSuffix(":" + key)
            }
        }.map { entry in
            TaskCommand(id: "local:" + entry.id, hostId: entry.hostID,
                idempotencyKey: entry.command.values["idempotencyKey"]?.stringValue ?? entry.id,
                kind: entry.command.type == "task.create" ? "create" : "follow_up",
                provider: entry.command.values["provider"]?.stringValue.flatMap(Provider.init(rawValue:))
                    ?? snapshot.sessions.first(where: { $0.id == entry.sessionID })?.provider ?? .codex,
                sessionId: entry.sessionID, workspaceId: entry.command.values["workspaceId"]?.stringValue,
                cwd: "", text: entry.preview, materialIds: nil, state: entry.state == .failed ? "failed" : "queued",
                createdAt: entry.createdAt.ISO8601Format(), updatedAt: entry.createdAt.ISO8601Format(),
                error: entry.error ?? entry.stateLabel)
        }
        return pending + snapshot.commands
    }

    var feedSnapshot: NativeSnapshot {
        var value = snapshot
        value.commands = displayedCommands
        return value
    }

    private func enqueueTask(_ command: ClientCommand) -> Bool {
        guard let host = snapshot.host?.id else {
            showNotice("请先连接运行设备，输入内容会保留。", tone: .failure)
            return false
        }
        guard outbox.enqueue(command, hostID: host) else {
            showNotice(outbox.storageIssue ?? "操作未能保存，输入内容会保留。", tone: .failure)
            return false
        }
        showNotice("已保存，正在交给运行设备")
        Task { await flushOutbox() }
        return true
    }

    func flushOutbox() async {
        await outbox.flush(snapshot: snapshot, send: client.send) { [weak self] response in
            guard let self else { return }
            self.snapshot = response.snapshot
            self.notifications.updateBadge(response.snapshot)
        }
    }

    func cancelQueuedCommand(_ command: TaskCommand) async {
        guard command.state == "queued" else { return }
        _ = await send(ClientCommand(type: "task.command.cancel", ["commandId": .string(command.id)]), notice: "撤回请求已确认")
    }

    func markFeedSeen(_ postID: String) async {
        guard !snapshot.seenPostIds.contains(postID) else { return }
        _ = await send(ClientCommand(type: "feed.seen", ["postId": .string(postID)]))
    }

    @discardableResult
    func dismissFeedItem(_ itemID: String, dismissed: Bool) async -> Bool {
        await send(ClientCommand(type: "feed.dismiss.set", [
            "itemId": .string(itemID),
            "dismissed": .bool(dismissed),
            "idempotencyKey": .string(UUID().uuidString),
        ]))
    }

    @discardableResult
    func decide(action: PendingAction, decision: Decision, input: [String: String]? = nil) async -> Bool {
        var values: [String: JSONValue] = [
            "actionId": .string(action.actionId),
            "sessionId": .string(action.sessionId),
            "decisionId": .string(decision.id),
            "idempotencyKey": .string(UUID().uuidString),
        ]
        if let phrase = decision.confirmationPhrase { values["confirmationPhrase"] = .string(phrase) }
        if let input {
            values["input"] = .object(input.mapValues(JSONValue.string))
        }
        let accepted = await send(ClientCommand(type: "action.decide", values), notice: "决定已提交")
        if accepted { metrics?.record(.approvalReceived) }
        return accepted
    }

    func setPinned(sessionID: String, pinned: Bool) async {
        _ = await send(ClientCommand(type: "task.pin", [
            "sessionId": .string(sessionID), "pinned": .bool(pinned),
            "idempotencyKey": .string(UUID().uuidString),
        ]))
    }

    func setArchived(sessionID: String, archived: Bool) async {
        _ = await send(ClientCommand(type: "task.archive", [
            "sessionId": .string(sessionID), "archived": .bool(archived),
            "idempotencyKey": .string(UUID().uuidString),
        ]), notice: archived ? "任务已归档" : "任务已恢复")
    }

    func updateAgent(projectID: String, displayName: String, avatar: String, bio: String, provider: Provider?) async -> Bool {
        await send(ClientCommand(type: "agent.profile.update", [
            "projectId": .string(projectID),
            "displayName": .string(displayName),
            "avatar": .string(avatar),
            "bio": .string(bio),
            "defaultProvider": provider.map { .string($0.rawValue) } ?? .null,
            "idempotencyKey": .string(UUID().uuidString),
        ]), notice: "Agent 资料已更新")
    }

    func setTrust(projectID: String, enabled: Bool) async {
        _ = await send(ClientCommand(type: "trust.policy.update", [
            "projectId": .string(projectID),
            "preset": .string(enabled ? "safe_automation" : "ask"),
            "idempotencyKey": .string(UUID().uuidString),
        ]), notice: enabled ? "已开启安全自动化" : "已改为每次询问")
    }

    func setLANApprovals(_ enabled: Bool) async {
        _ = await send(ClientCommand(type: "lan.approvals.set", ["enabled": .bool(enabled)]), notice: enabled ? "已允许局域网审批" : "已关闭局域网审批")
    }

    func importFiles(_ urls: [URL]) async -> [Material] {
        guard !urls.isEmpty, !importingFiles else { return [] }
        importingFiles = true
        defer { importingFiles = false }
        var result: [Material] = []
        for url in urls.prefix(10) {
            do { result.append(try await client.importMaterial(url)) }
            catch { showNotice("\(url.lastPathComponent)：\(error.localizedDescription)", tone: .failure) }
        }
        await refresh()
        return result
    }

    func openMaterial(_ material: Material) {
        if NSWorkspace.shared.open(client.materialURL(material.id)) { metrics?.record(.artifactOpened) }
    }

    func searchHistory(_ query: HistorySearch) async throws -> HistoryPage {
        guard let host = snapshot.host?.id else { throw URLError(.notConnectedToInternet) }
        var values: [String: JSONValue] = ["hostId": .string(host), "requestId": .string(query.requestId), "query": .string(query.query), "kind": .string(query.kind)]
        for (key, value) in [("projectId", query.projectId), ("after", query.after), ("cursor", query.cursor)] {
            if let value { values[key] = .string(value) }
        }
        let response = try await client.send(ClientCommand(type: "history.search", values))
        guard response.snapshot.host?.id == host else { throw LocalServiceIdentityError.mismatch }
        guard let page = response.messages.compactMap(\.page).first, page.hostId == host, page.requestId == query.requestId else {
            throw BridgeAPIError(code: "history_unavailable", message: response.messages.first(where: { $0.type == "error" })?.message ?? "历史检索暂不可用，请确认运行设备已更新并在线。", recoverable: true)
        }
        return page
    }

    func materialURL(_ material: Material) -> URL {
        client.materialURL(material.id)
    }

    func showNotice(_ text: String, tone: NativeNoticeTone = .neutral) {
        notice = NativeNotice(text: text, tone: tone)
        let id = notice?.id
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard self?.notice?.id == id else { return }
            self?.notice = nil
        }
    }
}
