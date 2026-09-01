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

    /// Button-level integration responses contain only integration rows. Merge
    /// them into the cached snapshot without deriving or mutating global service
    /// state; refreshStatus() remains the sole network-to-state authority.
    func replacingIntegrations(_ integrations: [IntegrationStatus]) -> LocalServiceStatus {
        LocalServiceStatus(
            ready: ready,
            cloud: cloud,
            pushNotifications: pushNotifications,
            pairedDeviceCount: pairedDeviceCount,
            integrations: integrations
        )
    }
}

enum PairingTransport: String, Codable {
    case cloud
    case lan
}

struct PairingPayload: Codable {
    let pairingId: String?
    let pairUrl: String
    let localPairUrl: String?
    let qrDataUrl: String
    let expiresAt: String
    let transport: PairingTransport?

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
    case stopping
    case ready
    case degraded(String)
    case manualStopped
    case unavailable(String)

    var label: String {
        switch self {
        case .starting: "正在准备"
        case .stopping: "正在停止"
        case .ready: "已连接"
        case .degraded: "连接不稳定"
        case .manualStopped: "已手动停止"
        case .unavailable: "需要修复"
        }
    }

    var recoveryMessage: String? {
        switch self {
        case .degraded(let message), .unavailable(let message): message
        case .starting, .stopping, .ready, .manualStopped: nil
        }
    }
}

enum LocalStatusEvaluation {
    static let notReadyMessage = "本地服务可达，但尚未准备好。Zimlo 会继续自动检查。"

    static func state(for status: LocalServiceStatus) -> ServiceState {
        status.ready ? .ready : .degraded(notReadyMessage)
    }
}

enum MenuStatusDescription {
    static func detail(for state: ServiceState, status: LocalServiceStatus?) -> String {
        if let message = state.recoveryMessage { return message }
        switch state {
        case .ready:
            guard let status else { return "本地服务已连接" }
            if status.pairedDeviceCount == 0 { return "还未连接手机" }
            if !status.cloud { return "手机连接暂不可用，Zimlo 会自动重试" }
            return "手机已连接，等待需要你处理的任务"
        case .starting:
            return "正在连接本地服务"
        case .stopping:
            return "正在完成后台服务切换"
        case .manualStopped:
            return "后台服务没有运行"
        case .degraded, .unavailable:
            return ""
        }
    }
}

@MainActor
final class ServiceController: ObservableObject {
    @Published private(set) var state: ServiceState = .starting
    @Published private(set) var status: LocalServiceStatus?
    @Published private(set) var pairing: PairingPayload?
    @Published private(set) var pairingImage: NSImage?
    @Published private(set) var pairingBusy = false
    @Published private(set) var integrationBusy = false
    @Published private(set) var controlBusy = false
    @Published private(set) var runtimePreparationMessage: String?
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
    /// Identity of an owned process whose intentional termination must not run
    /// the unexpected-exit recovery path. Ownership remains in `process` until
    /// exit is confirmed, so a termination timeout can never permit a duplicate.
    private var suppressedTerminationProcess: Process?
    private var monitorTask: Task<Void, Never>?
    private var startupActivity: NSObjectProtocol?
    private var stopping = false
    private var restartPolicy = RestartPolicy()
    private var recoveryStability = RecoveryStability()
    private var consecutiveHealthFailures = 0
    private var consecutiveStatusFailures = 0
    private var monitorTick = 0
    private var manualStop: ManualStopMarker { ManualStopMarker(url: Self.manualStopURL) }
    /// 熔断或终止型故障后为 true：自动路径（监控循环、进程退出回调）不再重启，
    /// 只有用户手动 retry() 才恢复。
    private var recoveryHalted = false
    /// 本次启动前 service.log 的末尾位置，用于只检索本次启动写入的日志段落。
    private var launchedLogOffset: UInt64 = 0
    private let baseURL = URL(string: "http://127.0.0.1:4747")!
    private let session: URLSession
    private let runtimeInstaller: RuntimeInstaller

    init(session: URLSession? = nil, runtimeInstaller: RuntimeInstaller? = nil) {
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = 8
            configuration.timeoutIntervalForResource = 20
            configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
            self.session = URLSession(configuration: configuration)
        }
        self.runtimeInstaller = runtimeInstaller ?? RuntimeInstaller()
    }

    var isReady: Bool {
        state == .ready
    }

    var menuBarSymbol: String {
        switch state {
        case .ready: "sparkles"
        case .starting, .stopping: "hourglass"
        case .degraded: "wifi.exclamationmark"
        case .manualStopped: "pause.circle"
        case .unavailable: "exclamationmark.triangle"
        }
    }

    var menuDetail: String {
        if state == .starting, let runtimePreparationMessage {
            return runtimePreparationMessage
        }
        return MenuStatusDescription.detail(for: state, status: status)
    }

    var completionSummary: String {
        guard let status else { return "Zimlo 会继续在菜单栏运行；你也可以稍后连接 Agent 和手机。" }
        if status.pairedDeviceCount == 0 {
            return "后台服务已经就绪。手机尚未连接，可稍后从菜单栏继续配对。"
        }
        if !status.integrations.allSatisfy(\.isReady) {
            return "手机已经连接。仍有 Agent 接入待完成，可稍后从菜单栏继续设置。"
        }
        return "它会继续在菜单栏运行。下一次 Agent 需要你时，打开手机就能处理。"
    }

    func start() async {
        // Terminal/circuit-open states are resumed only by retry(), which first
        // clears the halt. Incidental callers must not bypass the circuit.
        guard RecoveryHaltPolicy.allowsAutomaticStateTransition(
            recoveryHalted: recoveryHalted,
            stopping: stopping
        ) else { return }
        // 先探测 4747 上是否已有可复用的服务。正在运行的兼容 Bridge 是显式
        // 用户动作拉起的（zimlo start / zimlo mcp），复用它不受手动停止标记约束。
        let existingService = await probeExistingService()
        guard RecoveryHaltPolicy.allowsAutomaticStateTransition(
            recoveryHalted: recoveryHalted,
            stopping: stopping
        ) else { return }
        if transitionToManualStoppedIfRequested() { return }
        switch existingService {
        case .compatible:
            runtimePreparationMessage = nil
            resumeUnexpectedExitRecoveryForCompatibleReuse()
            let ready = await refreshStatus()
            guard RecoveryHaltPolicy.allowsAutomaticStateTransition(
                recoveryHalted: recoveryHalted,
                stopping: stopping
            ) else { return }
            if !ready {
                state = .degraded(LocalStatusEvaluation.notReadyMessage)
            }
            beginMonitoring()
            return
        case .incompatible:
            // 端口上有进程但不是协议匹配的 Zimlo 服务：终止型，不自动重启
            recoveryHalted = true
            haltMonitoring()
            if let owner = await describePortOwner() {
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
            _ = transitionToManualStoppedIfRequested()
            return
        case .proceed:
            break
        }
        stopping = false
        state = .starting
        runtimePreparationMessage = "正在准备 Bridge Runtime…"
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
            let runtime = try await runtimeInstaller.resolve { [weak self] message in
                self?.runtimePreparationMessage = message
            }
            runtimePreparationMessage = "正在启动本地 Bridge…"
            try launchService(using: runtime)
            // A freshly downloaded, notarized app may need a short first-launch
            // verification pass before its bundled runtime can accept requests.
            for _ in 0..<60 {
                try? await Task.sleep(for: .seconds(1))
                if transitionToManualStoppedIfRequested() { return }
                guard RecoveryHaltPolicy.allowsAutomaticStateTransition(
                    recoveryHalted: recoveryHalted,
                    stopping: stopping
                ) else { return }
                if await refreshStatus() {
                    guard RecoveryHaltPolicy.allowsAutomaticStateTransition(
                        recoveryHalted: recoveryHalted,
                        stopping: stopping
                    ) else { return }
                    beginMonitoring()
                    runtimePreparationMessage = nil
                    return
                }
            }
            if transitionToManualStoppedIfRequested() { return }
            guard RecoveryHaltPolicy.allowsAutomaticStateTransition(
                recoveryHalted: recoveryHalted,
                stopping: stopping
            ) else { return }
            recoveryHalted = true
            haltMonitoring()
            state = .unavailable("Zimlo 服务启动超时，请查看日志后重试。")
            runtimePreparationMessage = nil
        } catch {
            recoveryHalted = true
            haltMonitoring()
            runtimePreparationMessage = nil
            state = .unavailable(
                (error as? LocalizedError)?.errorDescription
                    ?? "后台服务启动失败。请查看日志后重新检查。"
            )
        }
    }

    /// 4747 上已有服务的协议探测：healthz 可达且 protocolVersion 匹配才可复用；
    /// 有响应但协议不符按"被非 Zimlo 进程占用"处理（契约见 apps/cli version.ts）。
    private func probeExistingService() async -> ExistingServiceProbe {
        do {
            var request = URLRequest(url: baseURL.appending(path: "healthz"))
            request.timeoutInterval = 2
            let (data, response) = try await session.data(for: request)
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
        guard !controlBusy else { return }
        controlBusy = true
        defer { controlBusy = false }
        manualStop.clear()
        recoveryHalted = false
        restartPolicy.reset()
        recoveryStability.reset()
        consecutiveHealthFailures = 0
        consecutiveStatusFailures = 0
        state = .starting

        // A launch timeout can leave the Process alive without a listening
        // Bridge. `launchBundledService()` intentionally refuses to create a
        // second owned process, so an explicit user retry must first retire that
        // exact Process instance. A compatible/incompatible response means the
        // port is owned by a responsive service and is never touched here.
        let probe = await probeExistingService()
        if ExplicitRetryProcessPolicy.shouldReplaceOwnedProcess(
            hasRunningOwnedProcess: process?.isRunning == true,
            probeIsUnreachable: probe == .unreachable
        ) {
            guard await terminateOwnedProcessForRetry() else { return }
        }
        await start()
    }

    /// Terminates only the Process object created and retained by this
    /// controller. Ownership is kept until exit is confirmed; suppression uses
    /// a separate identity so an external Bridge can never enter this path and a
    /// termination timeout can never allow a duplicate process to launch.
    private func terminateOwnedProcessForRetry() async -> Bool {
        guard await terminateRetainedOwnedProcess() else {
            recoveryHalted = true
            state = .unavailable("上次启动未完成，且无法安全停止其后台进程。请查看日志后重试。")
            return false
        }
        return true
    }

    private func terminateRetainedOwnedProcess() async -> Bool {
        guard let ownedProcess = process else { return true }
        guard ownedProcess.isRunning else {
            finalizeExitedOwnedProcess(ownedProcess)
            return true
        }

        suppressedTerminationProcess = ownedProcess
        ownedProcess.terminate()
        for _ in 0..<20 {
            if !ownedProcess.isRunning {
                finalizeExitedOwnedProcess(ownedProcess)
                return true
            }
            try? await Task.sleep(for: .milliseconds(100))
        }

        let retainOwnership = OwnedProcessLifecyclePolicy.shouldRetainReference(
            processIsStillRunning: ownedProcess.isRunning
        )
        guard !retainOwnership else { return false }
        finalizeExitedOwnedProcess(ownedProcess)
        return true
    }

    private func finalizeExitedOwnedProcess(_ ownedProcess: Process) {
        if process === ownedProcess { process = nil }
        if suppressedTerminationProcess === ownedProcess {
            suppressedTerminationProcess = nil
        }
    }

    /// A SIGTERM timeout can be followed by the same owned Bridge becoming
    /// responsive again. Once a compatible probe is accepted, that process is
    /// back under normal supervision; otherwise its later crash would be
    /// mistaken for the old intentional termination and silently swallowed.
    private func resumeUnexpectedExitRecoveryForCompatibleReuse() {
        let suppressionMatchesRetainedProcess = {
            guard let process else { return false }
            return process.isRunning && suppressedTerminationProcess === process
        }()
        guard OwnedProcessLifecyclePolicy.shouldClearSuppressionForCompatibleReuse(
            suppressionMatchesRetainedProcess: suppressionMatchesRetainedProcess
        ) else { return }
        suppressedTerminationProcess = nil
    }

    /// 与 `zimlo stop` 走同一条归属校验路径；无法证明归属的进程绝不会被结束。
    func stopService() async {
        guard !controlBusy else { return }
        controlBusy = true
        stopping = true
        state = .stopping
        monitorTask?.cancel()
        monitorTask = nil
        defer {
            stopping = false
            controlBusy = false
        }

        do {
            let runtime = try await runtimeInstaller.resolve { [weak self] message in
                self?.runtimePreparationMessage = message
            }
            let terminationStatus = try await Self.runBundledCommand(
                executable: runtime.node,
                arguments: [runtime.entrypoint.path, "stop"],
                currentDirectory: runtime.cliDirectory
            )
            guard terminationStatus == 0 else {
                recoveryHalted = true
                state = .unavailable(
                    "无法安全停止后台服务；Zimlo 没有结束归属不明的进程。请查看日志确认。"
                )
                return
            }
            process = nil
            status = nil
            pairing = nil
            pairingImage = nil
            recoveryHalted = false
            state = .manualStopped
        } catch {
            recoveryHalted = true
            state = .unavailable("无法停止后台服务。请查看日志后重试。")
        }
    }

    private func markHealthy(at now: Date = Date()) {
        if recoveryStability.observeHealthy(at: now) { restartPolicy.reset() }
    }

    @discardableResult
    func refreshStatus() async -> Bool {
        do {
            let url = baseURL.appending(path: "api/local/status")
            var request = URLRequest(url: url)
            request.timeoutInterval = 5
            let (data, response) = try await session.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                recordStatusFailure()
                return false
            }
            let decoded = try JSONDecoder().decode(LocalServiceStatus.self, from: data)
            status = decoded
            consecutiveStatusFailures = 0
            // Keep the fresh snapshot for diagnostics, but an incidental view
            // refresh must not turn a terminal/circuit-open controller back to
            // ready without restoring its monitor. retry() is the sole release.
            guard RecoveryHaltPolicy.allowsAutomaticStateTransition(
                recoveryHalted: recoveryHalted,
                stopping: stopping
            ) else { return false }
            state = LocalStatusEvaluation.state(for: decoded)
            guard decoded.ready else { return false }
            markHealthy()
            return true
        } catch is CancellationError {
            return false
        } catch {
            if (error as? URLError)?.code != .cancelled {
                recordStatusFailure()
            }
            return false
        }
    }

    /// Completion and other user-triggered gates need an immediate answer. The
    /// background monitor tolerates one missed status response to avoid flicker,
    /// but a stale `.ready` value must never let onboarding finish.
    @discardableResult
    func verifyReady() async -> Bool {
        let ready = await refreshStatus()
        guard !ready, state == .ready else { return ready }
        state = .degraded("无法确认后台服务仍在运行，请重新检查后再完成设置。")
        return false
    }

    private func recordStatusFailure() {
        consecutiveStatusFailures += 1
        guard consecutiveStatusFailures >= 2, state == .ready else { return }
        state = .degraded("本地服务状态暂时无法读取，正在自动恢复。")
    }

    /// Applies the durable CLI manual-stop marker as one atomic controller
    /// transition. Every caller gets the same stable state and monitor shutdown,
    /// so neither startup polling nor health polling can drift afterward.
    @discardableResult
    private func transitionToManualStoppedIfRequested() -> Bool {
        guard ManualStopTransitionPolicy.decide(manualStopSet: manualStop.isSet)
            == .enterManualStoppedAndHaltMonitoring else { return false }
        haltMonitoring()
        consecutiveHealthFailures = 0
        consecutiveStatusFailures = 0
        state = .manualStopped
        return true
    }

    func createPairing() async {
        guard !pairingBusy else { return }
        pairingBusy = true
        pairingIssue = nil
        pairingImage = nil
        defer { pairingBusy = false }
        do {
            var request = URLRequest(url: baseURL.appending(path: "api/local/pairing"))
            request.httpMethod = "POST"
            request.timeoutInterval = 15
            let (data, response) = try await session.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                pairingIssue = BridgeErrorDecoder.decode(data, fallback: "暂时无法创建配对二维码。")
                return
            }
            let payload = try JSONDecoder().decode(PairingPayload.self, from: data)
            pairing = payload
            pairingImage = payload.qrImage
            pairingIssue = nil
        } catch is CancellationError {
            return
        } catch {
            guard (error as? URLError)?.code != .cancelled else { return }
            pairingIssue = OperationIssueMapper.issue(
                for: error,
                fallback: "暂时无法创建配对二维码。",
                retryAction: "检查网络和后台服务后重试。"
            )
        }
    }

    func cancelPairing() async {
        guard let pairing, !pairingBusy else { return }
        guard let pairingId = pairing.pairingId else {
            self.pairing = nil
            pairingImage = nil
            return
        }
        pairingBusy = true
        pairingIssue = nil
        defer { pairingBusy = false }
        do {
            let safeID = pairingId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? pairingId
            var request = URLRequest(url: baseURL.appending(path: "api/local/pairing/\(safeID)"))
            request.httpMethod = "DELETE"
            request.timeoutInterval = 10
            let (data, response) = try await session.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                pairingIssue = BridgeErrorDecoder.decode(data, fallback: "暂时无法取消这个连接码。")
                return
            }
            self.pairing = nil
            pairingImage = nil
        } catch is CancellationError {
            return
        } catch {
            pairingIssue = OperationIssueMapper.issue(
                for: error,
                fallback: "暂时无法取消这个连接码。",
                retryAction: "请稍后重试。"
            )
        }
    }

    func installIntegration(_ target: String) async {
        guard !integrationBusy else { return }
        integrationBusy = true
        integrationIssue = nil
        defer { integrationBusy = false }
        do {
            var request = URLRequest(url: baseURL.appending(path: "api/local/integrations"))
            request.httpMethod = "POST"
            request.timeoutInterval = 20
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONEncoder().encode(["target": target])
            let (data, response) = try await session.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                integrationIssue = BridgeErrorDecoder.decode(data, fallback: "接入失败，请稍后重试。")
                return
            }
            let integrationResponse = try JSONDecoder().decode(IntegrationResponse.self, from: data)
            if let current = status {
                status = current.replacingIntegrations(integrationResponse.integrations)
            }
            integrationIssue = nil
            // This authoritative refresh owns any global state transition and
            // refuses promotion while recoveryHalted is set.
            _ = await refreshStatus()
        } catch is CancellationError {
            return
        } catch {
            guard (error as? URLError)?.code != .cancelled else { return }
            integrationIssue = OperationIssueMapper.issue(
                for: error,
                fallback: "接入失败，请稍后重试。",
                retryAction: "确认后台服务正常后重试。"
            )
        }
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

    private func launchService(using runtime: ManagedRuntime) throws {
        guard OwnedProcessLifecyclePolicy.canLaunchReplacement(
            hasRunningOwnedProcess: process?.isRunning == true
        ) else { return }

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
        process.executableURL = runtime.node
        process.arguments = DesktopBridgeLaunch.arguments(entrypoint: runtime.entrypoint)
        process.currentDirectoryURL = runtime.cliDirectory
        process.qualityOfService = .userInitiated
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = log
        process.standardError = log
        var environment = ProcessInfo.processInfo.environment
        for (key, value) in SystemProxyEnvironment.current() {
            if environment[key] == nil && environment[key.lowercased()] == nil {
                environment[key] = value
            }
        }
        environment.merge([
            "ZIMLO_DESKTOP": "1",
            "ZIMLO_STARTUP_TRACE": "1",
        ]) { _, bundled in bundled }
        process.environment = environment
        process.terminationHandler = { [weak self] process in
            Task { @MainActor in
                guard let self else { return }
                if self.suppressedTerminationProcess === process {
                    self.finalizeExitedOwnedProcess(process)
                    return
                }
                guard self.process === process else { return }
                self.process = nil
                guard UnexpectedExitRecoveryPolicy.shouldRecover(
                    stopping: self.stopping,
                    recoveryHalted: self.recoveryHalted,
                    terminationStatus: process.terminationStatus
                ) else { return }
                await self.handleUnexpectedExit()
            }
        }
        try process.run()
        self.process = process
    }

    private nonisolated static func runBundledCommand(
        executable: URL,
        arguments: [String],
        currentDirectory: URL
    ) async throws -> Int32 {
        try await Task.detached(priority: .userInitiated) {
            let command = Process()
            command.executableURL = executable
            command.arguments = arguments
            command.currentDirectoryURL = currentDirectory
            command.standardInput = FileHandle.nullDevice
            command.standardOutput = FileHandle.nullDevice
            command.standardError = FileHandle.nullDevice
            try command.run()
            command.waitUntilExit()
            return command.terminationStatus
        }.value
    }

    /// 进程非零退出后的处置：手动停止标记优先于一切自动恢复；终止型故障
    /// （端口占用、运行时/配置损坏）不自动重启，临时故障按指数退避重启，
    /// 密集崩溃触发熔断后等待用户手动重试。
    private func handleUnexpectedExit() async {
        recoveryStability.observeFailure()
        // 用户运行了 `zimlo stop`：标记存在时不做任何自动重启
        if transitionToManualStoppedIfRequested() { return }
        switch StartupLogInspector.classify(readCurrentLogSegment()) {
        case .portInUse:
            recoveryHalted = true
            haltMonitoring()
            if let owner = await describePortOwner() {
                state = .unavailable("端口 \(Self.port) 被 \(owner) 占用。请退出该进程后，在菜单栏选择“重试”。")
            } else {
                state = .unavailable("端口 \(Self.port) 已被其他进程占用。请释放端口后，在菜单栏选择“重试”。")
            }
        case .fatal(let reason):
            recoveryHalted = true
            haltMonitoring()
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
                haltMonitoring()
                state = .unavailable("后台服务两分钟内多次启动失败，已暂停自动重启。请查看日志后，在菜单栏选择“重试”。")
            }
        }
    }

    /// 读取本次启动写入的日志段落（尾部最多 64 KB）。
    /// 崩溃段落通常只有几 KB 的 node 栈，同步读取耗时可以忽略。
    private func readCurrentLogSegment() -> String {
        guard let handle = try? FileHandle(forReadingFrom: Self.logURL),
              let endOffset = try? handle.seekToEnd() else { return "" }
        defer { try? handle.close() }
        let limit: UInt64 = 64 * 1024
        let startOffset = max(launchedLogOffset, endOffset > limit ? endOffset - limit : 0)
        guard let _ = try? handle.seek(toOffset: startOffset) else { return "" }
        let data = handle.readData(ofLength: Int(limit))
        return String(data: data, encoding: .utf8) ?? ""
    }

    /// best-effort 用 lsof 识别端口占用者（如 "node (PID 1234)"），失败返回 nil。
    private func describePortOwner() async -> String? {
        let port = Self.port
        return await Task.detached(priority: .utility) { () -> String? in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
            process.arguments = ["-nP", "-iTCP:\(port)", "-sTCP:LISTEN", "-F", "pc"]
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = FileHandle.nullDevice
            guard let _ = try? process.run() else { return nil }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            guard let output = String(data: data, encoding: .utf8),
                  let owner = PortOwnerLookup.parse(output) else { return nil }
            return "\(owner.command) (PID \(owner.pid))"
        }.value
    }

    private func beginMonitoring() {
        guard RecoveryHaltPolicy.allowsAutomaticStateTransition(
            recoveryHalted: recoveryHalted,
            stopping: stopping
        ), monitorTask == nil else { return }
        monitorTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(8))
                guard let self else { return }
                if self.transitionToManualStoppedIfRequested() { return }
                guard RecoveryHaltPolicy.allowsAutomaticStateTransition(
                    recoveryHalted: self.recoveryHalted,
                    stopping: self.stopping
                ) else {
                    self.monitorTask = nil
                    return
                }
                self.monitorTick += 1
                switch await self.probeExistingService() {
                case .compatible:
                    self.resumeUnexpectedExitRecoveryForCompatibleReuse()
                    self.consecutiveHealthFailures = 0
                    // /api/local/status performs integration inspection. Keep the idle
                    // heartbeat cheap and refresh the full snapshot every fourth tick,
                    // or immediately while recovering from a degraded state.
                    if self.monitorTick.isMultiple(of: 4) || !self.isReady {
                        _ = await self.refreshStatus()
                    }
                case .incompatible:
                    self.recoveryHalted = true
                    self.haltMonitoring()
                    self.state = .unavailable("端口 \(Self.port) 上的服务协议不匹配。请停止旧服务后重新检查。")
                    return
                case .unreachable:
                    self.consecutiveHealthFailures += 1
                    if self.consecutiveHealthFailures >= 2 {
                        self.state = .degraded("后台服务暂时无响应，正在自动恢复。")
                    }
                    guard self.consecutiveHealthFailures >= 3 else { continue }
                    self.consecutiveHealthFailures = 0
                    await self.recoverFromHealthFailure()
                }
            }
        }
    }

    private func recoverFromHealthFailure() async {
        recoveryStability.observeFailure()
        switch restartPolicy.recordFailure() {
        case .retry(let delay):
            state = .degraded("后台服务无响应，\(Int(delay)) 秒后自动重试。")
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, !recoveryHalted, !stopping else { return }
        case .circuitOpen:
            recoveryHalted = true
            haltMonitoring()
            state = .unavailable("后台服务两分钟内多次失去响应，已暂停自动重启。请查看日志后重新检查。")
            return
        }

        if process?.isRunning == true {
            // Only the Process retained by this controller enters this path.
            // The shared helper keeps ownership until exit is confirmed.
            guard await terminateRetainedOwnedProcess() else {
                recoveryHalted = true
                haltMonitoring()
                state = .unavailable("后台服务无响应且无法自动停止。请查看日志后重新检查。")
                return
            }
        }
        await start()
    }

    private func haltMonitoring() {
        monitorTask?.cancel()
        monitorTask = nil
    }
}

/// 4747 端口探测结果（见 ServiceController.probeExistingService）。
private enum ExistingServiceProbe: Equatable {
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
