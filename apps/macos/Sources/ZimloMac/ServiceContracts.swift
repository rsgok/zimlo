import Foundation

// 本文件集中 macOS App 与 apps/cli 之间的磁盘/协议契约：
// - ~/.zimlo/run/manual-stop 手动停止标记（apps/cli service-state.ts）
// - /healthz 的 protocolVersion（apps/cli version.ts）
// - ~/.zimlo/run/service.json 服务描述符（apps/cli service-state.ts）
// 两侧的字段名与取值必须保持对齐，改动任一侧时检查另一侧。

/// /healthz 响应中 App 关心的部分。
struct HealthResponse: Decodable {
    let protocolVersion: Int?
}

enum HealthCheck {
    static let expectedProtocolVersion = ZimloContract.protocolVersion

    static func isCompatible(protocolVersion: Int?) -> Bool {
        protocolVersion == expectedProtocolVersion
    }
}

/// The desktop-owned Bridge must be reachable from an iPhone when cloud
/// pairing is unavailable. The Bridge still restricts local admin routes to
/// loopback and accepts phone traffic only from trusted private networks.
enum DesktopBridgeLaunch {
    static func arguments(entrypoint: URL) -> [String] {
        ["--use-env-proxy", entrypoint.path, "start", "--lan"]
    }
}

enum PairingAutostartPolicy {
    static func shouldCreate(
        serviceState: ServiceState,
        hasPairing: Bool,
        isPaired: Bool
    ) -> Bool {
        guard !hasPairing, !isPaired else { return false }
        return serviceState == .ready
    }
}

/// ~/.zimlo/run/service.json：运行中 Bridge 写下的服务描述符。
struct ServiceDescriptor: Decodable, Equatable {
    let pid: Int
    let port: Int
    let version: String
    let protocolVersion: Int
    let startedAt: String
    let socketPath: String
    /// 自动拉起实例为 autostart.log；手动 `zimlo start` 输出在终端，为 null。
    let logPath: String?

    static func decode(_ data: Data) -> ServiceDescriptor? {
        try? JSONDecoder().decode(Self.self, from: data)
    }

    /// "查看日志"的路径选择：优先 descriptor 声明的 logPath；
    /// descriptor 缺失/损坏或 logPath 为 null/空串时回退到 fallback。
    static func resolvedLogPath(descriptor: ServiceDescriptor?, fallback: String) -> String {
        if let logPath = descriptor?.logPath, !logPath.isEmpty {
            return logPath
        }
        return fallback
    }
}

/// ~/.zimlo/run/manual-stop 标记。
///
/// 契约（apps/cli service-state.ts）：`zimlo stop` 写入标记；只有 macOS 的
/// 自动管理（启动自动拉起、崩溃自动重启、监控循环）尊重它；App 内的显式
/// 动作（菜单"启动服务"/"重试"）先 clear 再启动，`zimlo start` 同理。
struct ManualStopMarker {
    let url: URL

    var isSet: Bool {
        FileManager.default.fileExists(atPath: url.path)
    }

    /// 与 CLI 的 markManualStop 格式一致（一行 ISO 时间戳）。App 正常运行
    /// 不会写标记，此方法主要供测试与 CLI 行为对拍。
    func set(at date: Date = Date()) {
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try? "\(date.ISO8601Format())\n".write(to: url, atomically: true, encoding: .utf8)
    }

    func clear() {
        try? FileManager.default.removeItem(at: url)
    }
}

/// 自动管理路径（App 启动、崩溃重启、监控循环）的启动前置判定。
enum AutoStartGate: Equatable {
    case proceed
    case manualStopped
    case halted

    static func decide(recoveryHalted: Bool, manualStopSet: Bool) -> AutoStartGate {
        if recoveryHalted { return .halted }
        if manualStopSet { return .manualStopped }
        return .proceed
    }
}
