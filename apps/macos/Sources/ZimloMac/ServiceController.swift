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

    var expiresAtDate: Date? {
        if let date = try? Date(expiresAt, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) {
            return date
        }
        return try? Date(expiresAt, strategy: Date.ISO8601FormatStyle())
    }

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
    case manualStopped
    case unavailable(String)

    var label: String {
        switch self {
        case .starting: "正在准备"
        case .ready: "已连接"
        case .manualStopped: "已手动停止"
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
    /// 按钮级操作错误：只展示在对应按钮/步骤附近，不影响全局 state。
    @Published private(set) var pairingIssue: OperationIssue?
    @Published private(set) var integrationIssue: OperationIssue?

    static let port = 4747
    static let logDirectory = FileManager.default.homeDirectoryForCurrentUser
        .appending(path: "Library/Logs/Zimlo", directoryHint: .isDirectory)
    static let logURL = logDirectory.appending(path: "service.log")
    /// 与 apps/cli 的 ZIMLO_PATHS.root 一致（mac App 不设置 ZIMLO_HOME）。
    static let serviceDirectory = FileManager.default.homeDirectoryForCurrentUser
        .appending(path: ".zimlo", directoryHint: .isDirectory)
    static let runDirectory = serviceDirectory.appending(path: "run", directoryHint: .isDirectory)
    static let manualStopURL = runDirectory.appending(path: "manual-stop")
    static let serviceDescriptorURL = runDirectory.appending(path: "service.json")

    private var process: Process?
    private var monitorTask: Task<Void, Never>?
    private var startupActivity: NSObjectProtocol?
    private var stopping = false
    private var restartPolicy = RestartPolicy()
    private var recoveryStability = RecoveryStability()
    private var manualStop: ManualStopMarker { ManualStopMarker(url: Self.manualStopURL) }
    /// 熔断或终止型故障后为 true：自动路径（监控循环、进程退出回调）不再重启，
    /// 只有用户手动 retry() 才恢复。
    private var recoveryHalted = false
    /// 本次启动前 service.log 的末尾位置，用于只检索本次启动写入的日志段落。
    private var launchedLogOffset: UInt64 = 0
    private let baseURL = URL(string: "http://127.0.0.1:4747")!

    var isReady: Bool {
        state == .ready
    }

    func start() async {
        // 先探测 4747 上是否已有可复用的服务。正在运行的兼容 Bridge 是显式
        // 用户动作拉起的（zimlo start / zimlo mcp），复用它不受手动停止标记约束。
        switch await probeExistingService() {
        case .compatible:
            _ = await refreshStatus()
            state = .ready
            beginMonitoring()
            return
        case .incompatible:
            // 端口上有进程但不是协议匹配的 Zimlo 服务：终止型，不自动重启
            recoveryHalted = true
            if let owner = describePortOwner() {
                state = .unavailable("端口 \(Self.port) 被 \(owner) 占用，且不是兼容的 Zimlo 服务。请退出该进程后，在菜单栏选择“重试”。")
            } else {
                state = .unavailable("端口 \(Self.port) 被其他进程占用，且不是兼容的 Zimlo 服务。请释放端口后，在菜单栏选择“重试”。")
            }
            return
        case .unreachable:
            break
        }
        // 自动管理路径尊重手动停止标记；显式动作（retry()）已先清除标记。
        switch AutoStartGate.decide(recoveryHalted: recoveryHalted, manualStopSet: manualStop.isSet) {
        case .halted:
            return
        case .manualStopped:
            state = .manualStopped
            return
        case .proceed:
            break
        }
        stopping = false
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
            state = .unavailable("Zimlo 服务启动超时，请查看日志后重试。")
        } catch {
            state = .unavailable(error.localizedDescription)
        }
    }

    /// 4747 上已有服务的协议探测：healthz 可达且 protocolVersion 匹配才可复用；
    /// 有响应但协议不符按"被非 Zimlo 进程占用"处理（契约见 apps/cli version.ts）。
    private func probeExistingService() async -> ExistingServiceProbe {
        do {
            let (data, response) = try await URLSession.shared.data(from: baseURL.appending(path: "healthz"))
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let health = try? JSONDecoder().decode(HealthResponse.self, from: data),
                  HealthCheck.isCompatible(protocolVersion: health.protocolVersion) else {
                return .incompatible
            }
            return .compatible
        } catch {
            return .unreachable
        }
    }

    /// 用户显式动作（菜单"启动服务"/"重试"）：先清除手动停止标记（与
    /// `zimlo start` 清标记的行为对齐），解除熔断/终止态后走完整启动流程。
    func retry() async {
        manualStop.clear()
        recoveryHalted = false
        restartPolicy.reset()
        recoveryStability.reset()
        state = .starting
        await start()
    }

    private func markHealthy(at now: Date = Date()) {
        recoveryHalted = false
        if recoveryStability.observeHealthy(at: now) { restartPolicy.reset() }
    }

    @discardableResult
    func refreshStatus() async -> Bool {
        do {
            let url = baseURL.appending(path: "api/local/status")
            let (data, response) = try await URLSession.shared.data(from: url)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return false }
            status = try JSONDecoder().decode(LocalServiceStatus.self, from: data)
            state = .ready
            markHealthy()
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
                pairingIssue = BridgeErrorDecoder.decode(data, fallback: "暂时无法创建配对二维码。")
                return
            }
            pairing = try JSONDecoder().decode(PairingPayload.self, from: data)
            pairingIssue = nil
        } catch {
            pairingIssue = OperationIssue(message: error.localizedDescription, action: nil)
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
                integrationIssue = BridgeErrorDecoder.decode(data, fallback: "接入失败，请稍后重试。")
                return
            }
            let integrationResponse = try JSONDecoder().decode(IntegrationResponse.self, from: data)
            status = LocalServiceStatus(
                ready: true,
                cloud: status?.cloud ?? true,
                pushNotifications: status?.pushNotifications ?? false,
                pairedDeviceCount: status?.pairedDeviceCount ?? 0,
                integrations: integrationResponse.integrations
            )
            integrationIssue = nil
            state = .ready
        } catch {
            integrationIssue = OperationIssue(message: error.localizedDescription, action: nil)
        }
    }

    func openDashboard() {
        NSWorkspace.shared.open(baseURL)
    }

    func openLog() {
        let url = preferredLogURL()
        if url == Self.logURL, !FileManager.default.fileExists(atPath: url.path) {
            try? FileManager.default.createDirectory(at: Self.logDirectory, withIntermediateDirectories: true)
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
        NSWorkspace.shared.open(url)
    }

    /// 优先使用运行中 Bridge 在 service.json 里声明的 logPath（自动拉起实例为
    /// autostart.log）；descriptor 缺失/损坏或 logPath 为 null（手动 `zimlo start`，
    /// 包括 App 自己拉起的实例）时回退到 App 维护的 service.log。
    func preferredLogURL() -> URL {
        let descriptor = (try? Data(contentsOf: Self.serviceDescriptorURL))
            .flatMap(ServiceDescriptor.decode)
        return URL(fileURLWithPath: ServiceDescriptor.resolvedLogPath(
            descriptor: descriptor,
            fallback: Self.logURL.path
        ))
    }

    func openServiceDirectory() {
        try? FileManager.default.createDirectory(at: Self.serviceDirectory, withIntermediateDirectories: true)
        NSWorkspace.shared.open(Self.serviceDirectory)
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

        try FileManager.default.createDirectory(at: Self.logDirectory, withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: Self.logURL.path) {
            FileManager.default.createFile(atPath: Self.logURL.path, contents: nil)
        }
        let log = try FileHandle(forWritingTo: Self.logURL)
        try log.seekToEnd()
        // 记录本次启动的日志起点，进程崩溃后只检索这之后写入的段落，
        // 避免被历史日志里的旧报错误导。
        launchedLogOffset = try log.offset()

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
                await self.handleUnexpectedExit()
            }
        }
        try process.run()
        self.process = process
    }

    /// 进程非零退出后的处置：手动停止标记优先于一切自动恢复；终止型故障
    /// （端口占用、运行时/配置损坏）不自动重启，临时故障按指数退避重启，
    /// 密集崩溃触发熔断后等待用户手动重试。
    private func handleUnexpectedExit() async {
        recoveryStability.observeFailure()
        // 用户运行了 `zimlo stop`：标记存在时不做任何自动重启
        if manualStop.isSet {
            state = .manualStopped
            return
        }
        switch StartupLogInspector.classify(readCurrentLogSegment()) {
        case .portInUse:
            recoveryHalted = true
            if let owner = describePortOwner() {
                state = .unavailable("端口 \(Self.port) 被 \(owner) 占用。请退出该进程后，在菜单栏选择“重试”。")
            } else {
                state = .unavailable("端口 \(Self.port) 已被其他进程占用。请释放端口后，在菜单栏选择“重试”。")
            }
        case .fatal(let reason):
            recoveryHalted = true
            state = .unavailable("\(reason)修复后在菜单栏选择“重试”。")
        case .transient:
            switch restartPolicy.recordFailure() {
            case .retry(let delay):
                state = .unavailable("后台服务意外停止，\(Int(delay)) 秒后自动重试。")
                try? await Task.sleep(for: .seconds(delay))
                guard !stopping, !recoveryHalted else { return }
                await start()
            case .circuitOpen:
                recoveryHalted = true
                state = .unavailable("后台服务两分钟内多次启动失败，已暂停自动重启。请查看日志后，在菜单栏选择“重试”。")
            }
        }
    }

    /// 读取本次启动写入的日志段落（尾部最多 64 KB）。
    /// 崩溃段落通常只有几 KB 的 node 栈，同步读取耗时可以忽略。
    private func readCurrentLogSegment() -> String {
        guard let handle = try? FileHandle(forReadingFrom: Self.logURL),
              let _ = try? handle.seek(toOffset: launchedLogOffset) else { return "" }
        defer { try? handle.close() }
        var data = handle.readDataToEndOfFile()
        let limit = 64 * 1024
        if data.count > limit {
            data = data.suffix(limit)
        }
        return String(data: data, encoding: .utf8) ?? ""
    }

    /// best-effort 用 lsof 识别端口占用者（如 "node (PID 1234)"），失败返回 nil。
    private func describePortOwner() -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        process.arguments = ["-nP", "-iTCP:\(Self.port)", "-sTCP:LISTEN", "-F", "pc"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        guard let _ = try? process.run() else { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard let output = String(data: data, encoding: .utf8),
              let owner = PortOwnerLookup.parse(output) else { return nil }
        return "\(owner.command) (PID \(owner.pid))"
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

/// 4747 端口探测结果（见 ServiceController.probeExistingService）。
private enum ExistingServiceProbe {
    /// 协议匹配的 Zimlo Bridge，可复用。
    case compatible
    /// 有进程监听但协议不符，按非 Zimlo 进程占用处理。
    case incompatible
    /// 端口上没有服务。
    case unreachable
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
