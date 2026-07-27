import AppKit
import Foundation

struct IntegrationStatus: Codable, Identifiable, Hashable {
    let id: String
    let provider: String
    let surface: String
    let state: String
    let label: String
    let detail: String

    var isReady: Bool {
        state == "ready" || state == "shared"
    }
}

struct LocalServiceStatus: Codable {
    let ready: Bool
    let cloud: Bool
    let pushNotifications: Bool
    let pairedDeviceCount: Int
    let integrations: [IntegrationStatus]

    private enum CodingKeys: String, CodingKey {
        case ready, cloud, pushNotifications, pairedDeviceCount, integrations
    }

    init(
        ready: Bool,
        cloud: Bool,
        pushNotifications: Bool,
        pairedDeviceCount: Int,
        integrations: [IntegrationStatus]
    ) {
        self.ready = ready
        self.cloud = cloud
        self.pushNotifications = pushNotifications
        self.pairedDeviceCount = pairedDeviceCount
        self.integrations = integrations
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        ready = try values.decode(Bool.self, forKey: .ready)
        cloud = try values.decode(Bool.self, forKey: .cloud)
        pushNotifications = try values.decodeIfPresent(Bool.self, forKey: .pushNotifications) ?? false
        pairedDeviceCount = try values.decodeIfPresent(Int.self, forKey: .pairedDeviceCount) ?? 0
        integrations = try values.decode([IntegrationStatus].self, forKey: .integrations)
    }
}

struct PairingPayload: Codable {
    let pairUrl: String
    let qrDataUrl: String
    let expiresAt: String

    var qrImage: NSImage? {
        guard let comma = qrDataUrl.firstIndex(of: ","),
              let data = Data(base64Encoded: String(qrDataUrl[qrDataUrl.index(after: comma)...])) else {
            return nil
        }
        return NSImage(data: data)
    }
}

enum ServiceState: Equatable {
    case starting
    case ready
    case unavailable(String)

    var label: String {
        switch self {
        case .starting: "正在准备"
        case .ready: "已连接"
        case .unavailable: "需要修复"
        }
    }
}

@MainActor
final class ServiceController: ObservableObject {
    @Published private(set) var state: ServiceState = .starting
    @Published private(set) var status: LocalServiceStatus?
    @Published private(set) var pairing: PairingPayload?
    @Published private(set) var busy = false

    private var process: Process?
    private var monitorTask: Task<Void, Never>?
    private var startupActivity: NSObjectProtocol?
    private var stopping = false
    private let baseURL = URL(string: "http://127.0.0.1:4747")!

    var isReady: Bool {
        state == .ready
    }

    func start() async {
        stopping = false
        if await refreshStatus() {
            beginMonitoring()
            return
        }
        state = .starting
        startupActivity = ProcessInfo.processInfo.beginActivity(
            options: [.userInitiated, .latencyCritical],
            reason: "Starting the local Zimlo service"
        )
        defer {
            if let startupActivity {
                ProcessInfo.processInfo.endActivity(startupActivity)
                self.startupActivity = nil
            }
        }
        do {
            try launchBundledService()
            // A freshly downloaded, notarized app may need a short first-launch
            // verification pass before its bundled runtime can accept requests.
            for _ in 0..<240 {
                try? await Task.sleep(for: .milliseconds(250))
                if await refreshStatus() {
                    beginMonitoring()
                    return
                }
            }
            state = .unavailable("Zimlo 服务启动超时，请重试。")
        } catch {
            state = .unavailable(error.localizedDescription)
        }
    }

    @discardableResult
    func refreshStatus() async -> Bool {
        do {
            let url = baseURL.appending(path: "api/local/status")
            let (data, response) = try await URLSession.shared.data(from: url)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return false }
            status = try JSONDecoder().decode(LocalServiceStatus.self, from: data)
            state = .ready
            return true
        } catch {
            return false
        }
    }

    func createPairing() async {
        busy = true
        defer { busy = false }
        do {
            var request = URLRequest(url: baseURL.appending(path: "api/local/pairing"))
            request.httpMethod = "POST"
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                let value = try? JSONDecoder().decode(ServiceError.self, from: data)
                throw ServiceFailure.message(value?.error ?? "暂时无法创建配对二维码。")
            }
            pairing = try JSONDecoder().decode(PairingPayload.self, from: data)
        } catch {
            state = .unavailable(error.localizedDescription)
        }
    }

    func installIntegration(_ target: String) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            var request = URLRequest(url: baseURL.appending(path: "api/local/integrations"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONEncoder().encode(["target": target])
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                let value = try? JSONDecoder().decode(ServiceError.self, from: data)
                throw ServiceFailure.message(value?.error ?? "接入失败，请稍后重试。")
            }
            let integrationResponse = try JSONDecoder().decode(IntegrationResponse.self, from: data)
            status = LocalServiceStatus(
                ready: true,
                cloud: status?.cloud ?? true,
                pushNotifications: status?.pushNotifications ?? false,
                pairedDeviceCount: status?.pairedDeviceCount ?? 0,
                integrations: integrationResponse.integrations
            )
            state = .ready
        } catch {
            state = .unavailable(error.localizedDescription)
        }
    }

    func openDashboard() {
        NSWorkspace.shared.open(baseURL)
    }

    func stopOwnedService() {
        stopping = true
        monitorTask?.cancel()
        monitorTask = nil
        guard let process, process.isRunning else { return }
        process.terminate()
        self.process = nil
    }

    private func launchBundledService() throws {
        if process?.isRunning == true { return }
        guard let resources = Bundle.main.resourceURL else {
            throw ServiceFailure.message("应用资源不完整，请重新安装 Zimlo。")
        }
        let node = resources.appending(path: "runtime/node")
        let entrypoint = resources.appending(path: "runtime/cli/dist/index.js")
        guard FileManager.default.isExecutableFile(atPath: node.path),
              FileManager.default.fileExists(atPath: entrypoint.path) else {
            throw ServiceFailure.message("应用内置服务缺失，请重新下载 Zimlo。")
        }

        let logs = FileManager.default.homeDirectoryForCurrentUser
            .appending(path: "Library/Logs/Zimlo", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
        let logURL = logs.appending(path: "service.log")
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
        let log = try FileHandle(forWritingTo: logURL)
        try log.seekToEnd()

        let process = Process()
        process.executableURL = node
        process.arguments = [entrypoint.path, "start"]
        process.currentDirectoryURL = resources.appending(path: "runtime/cli")
        process.qualityOfService = .userInitiated
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = log
        process.standardError = log
        process.environment = ProcessInfo.processInfo.environment.merging([
            "ZIMLO_DESKTOP": "1",
            "ZIMLO_STARTUP_TRACE": "1",
        ]) { _, bundled in bundled }
        process.terminationHandler = { [weak self] process in
            Task { @MainActor in
                guard let self else { return }
                if self.process === process {
                    self.process = nil
                }
                guard !self.stopping, process.terminationStatus != 0 else { return }
                self.state = .unavailable("后台服务意外停止，Zimlo 正在恢复连接。")
                try? await Task.sleep(for: .seconds(1))
                guard !self.stopping else { return }
                await self.start()
            }
        }
        try process.run()
        self.process = process
    }

    private func beginMonitoring() {
        guard monitorTask == nil else { return }
        monitorTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(8))
                guard let self else { return }
                if !(await self.refreshStatus()), !(self.process?.isRunning ?? false) {
                    await self.start()
                }
            }
        }
    }
}

private struct ServiceError: Codable {
    let error: String
}

private struct IntegrationResponse: Codable {
    let integrations: [IntegrationStatus]
}

private enum ServiceFailure: LocalizedError {
    case message(String)

    var errorDescription: String? {
        switch self {
        case .message(let value): value
        }
    }
}
