import AppKit
import Combine
import CryptoKit
import Foundation
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

        @Sendable func checkedData(for request: URLRequest) async throws -> Data {
            let (data, response) = try await session.data(for: request)
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
                let request = URLRequest(url: baseURL.appending(path: "api/local/snapshot"))
                return try decoder.decode(NativeSnapshot.self, from: await checkedData(for: request))
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

    init(client: NativeBridgeClient, notifications: MacNotificationManager = .shared) {
        self.client = client
        self.notifications = notifications
    }

    func run() async {
        if loadState == .idle { loadState = .loading }
        while !Task.isCancelled {
            await refresh()
            do { try await Task.sleep(for: .seconds(2)) }
            catch { return }
        }
    }

    func refresh() async {
        guard !refreshInFlight else { return }
        refreshInFlight = true
        defer { refreshInFlight = false }
        do {
            let next = try await client.fetchSnapshot()
            if next.sequence >= snapshot.sequence {
                let previous = snapshot
                let shouldNotify = loadState == .loaded && next.sequence > previous.sequence
                snapshot = next
                if shouldNotify {
                    await notifications.process(previous: previous, next: next)
                } else {
                    notifications.updateBadge(next)
                }
            }
            loadState = .loaded
        } catch is CancellationError {
            return
        } catch {
            if snapshot.sequence == 0 { loadState = .failed(error.localizedDescription) }
        }
    }

    @discardableResult
    func send(_ command: ClientCommand, notice successText: String? = nil) async -> Bool {
        do {
            let response = try await client.send(command)
            snapshot = response.snapshot
            notifications.updateBadge(response.snapshot)
            if let nextDevices = response.messages.first(where: { $0.type == "devices.list" })?.devices {
                devices = nextDevices.filter(\.isActivePhone).sorted { $0.lastSeenAt > $1.lastSeenAt }
            }
            if let error = response.messages.first(where: { $0.type == "error" }) {
                throw BridgeAPIError(
                    code: error.code ?? "command_failed",
                    message: error.message ?? "操作未完成。",
                    recoverable: true
                )
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
        await send(ClientCommand(type: "task.create", [
            "provider": .string(provider.rawValue),
            "workspaceId": .string(workspaceID),
            "text": .string(text),
            "materialIds": .array(materialIDs.map(JSONValue.string)),
            "idempotencyKey": .string(UUID().uuidString),
        ]), notice: "任务已交给 \(provider.label)")
    }

    func followUp(sessionID: String, text: String, materialIDs: [String]) async -> Bool {
        await send(ClientCommand(type: "task.follow_up", [
            "sessionId": .string(sessionID),
            "text": .string(text),
            "materialIds": .array(materialIDs.map(JSONValue.string)),
            "idempotencyKey": .string(UUID().uuidString),
        ]), notice: "回复已发送")
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

    func decide(action: PendingAction, decision: Decision, input: [String: String]? = nil) async {
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
        _ = await send(ClientCommand(type: "action.decide", values), notice: "决定已提交")
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
        guard !urls.isEmpty else { return [] }
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
        NSWorkspace.shared.open(client.materialURL(material.id))
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
