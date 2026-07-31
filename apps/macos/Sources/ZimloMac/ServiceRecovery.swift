import Foundation

/// 按钮级操作错误：只展示在触发它的按钮/步骤附近，
/// 不写入全局 ServiceState，避免单次操作失败让整个菜单栏变成"需要修复"。
struct OperationIssue: Equatable {
    let message: String
    let action: String?
}

/// 解析 Bridge 的错误响应体，产出面向用户的展示文案。
///
/// 兼容顺序：
/// 1. 新版稳定结构 `{ code, message, recoverable, action? }`；
/// 2. 旧 Fastify 默认结构 `{ statusCode, error, message }` 或 `{ error }`。
///    Fastify 默认错误里 `message` 是具体原因、`error` 只是 HTTP 状态名，
///    因此回退时优先 `message`，并过滤掉 "Internal Server Error" 这类状态名；
/// 3. 都解析不出时使用调用方给的通用文案。
enum BridgeErrorDecoder {
    /// 没有信息量的 HTTP 状态名，永远不直接展示给用户。
    private static let httpStatusNames: Set<String> = [
        "Bad Request", "Unauthorized", "Forbidden", "Not Found",
        "Method Not Allowed", "Conflict", "Unprocessable Entity",
        "Internal Server Error", "Bad Gateway", "Service Unavailable", "Gateway Timeout",
    ]

    static func decode(_ data: Data, fallback: String) -> OperationIssue {
        if let stable = try? JSONDecoder().decode(StableError.self, from: data),
           !stable.message.isEmpty {
            return OperationIssue(message: stable.message, action: stable.action)
        }
        if let legacy = try? JSONDecoder().decode(LegacyError.self, from: data) {
            for candidate in [legacy.message, legacy.error] {
                guard let candidate, !candidate.isEmpty, !httpStatusNames.contains(candidate) else { continue }
                return OperationIssue(message: candidate, action: nil)
            }
        }
        return OperationIssue(message: fallback, action: nil)
    }

    private struct StableError: Decodable {
        let code: String
        let message: String
        let recoverable: Bool?
        let action: String?
    }

    private struct LegacyError: Decodable {
        let error: String?
        let message: String?
    }
}

/// 后台服务自动重启策略：指数退避 + 熔断。
///
/// - 退避档位随连续失败数爬升：1、2、4、8、16、30 秒封顶（服务恢复后 reset）；
/// - 两分钟滑动窗口内失败达到 5 次说明是密集的崩溃循环，判定熔断，
///   不再自动重启，等待用户在菜单里手动点"重试"。
struct RestartPolicy {
    static let delays: [TimeInterval] = [1, 2, 4, 8, 16, 30]
    static let window: TimeInterval = 120
    static let maxFailures = 5

    enum Decision: Equatable {
        case retry(after: TimeInterval)
        case circuitOpen
    }

    /// 连续失败次数，决定退避档位。
    private(set) var consecutiveFailures = 0
    /// 滑动窗口内的失败时间，只用于熔断判定。
    private var recentFailures: [Date] = []

    mutating func recordFailure(at now: Date = Date()) -> Decision {
        consecutiveFailures += 1
        recentFailures.removeAll { now.timeIntervalSince($0) >= Self.window }
        recentFailures.append(now)
        guard recentFailures.count < Self.maxFailures else { return .circuitOpen }
        return .retry(after: Self.delays[min(consecutiveFailures - 1, Self.delays.count - 1)])
    }

    mutating func reset() {
        consecutiveFailures = 0
        recentFailures.removeAll()
    }
}

/// 只有连续健康达到稳定窗口才允许清空崩溃历史。一次短暂的 /healthz 成功
/// 不能证明服务已经恢复，否则“启动几秒就崩”的循环永远触发不了熔断。
struct RecoveryStability {
    static let stableWindow: TimeInterval = 120
    private(set) var healthySince: Date?

    mutating func observeHealthy(at now: Date = Date()) -> Bool {
        if healthySince == nil { healthySince = now }
        return now.timeIntervalSince(healthySince ?? now) >= Self.stableWindow
    }

    mutating func observeFailure() {
        healthySince = nil
    }

    mutating func reset() {
        healthySince = nil
    }
}

/// 从本次启动写入的日志段落识别终止型故障。
///
/// node 对所有未捕获异常都返回退出码 1，退出码无法区分"端口被占"与
/// "临时崩溃"；桥进程的 stderr 已重定向到 service.log，检索本次启动
/// 写入段落中的已知关键字是最简单可靠的区分方案。日志读不到或匹配不到
/// 时按临时故障处理（仍有指数退避与熔断兜底）。
enum StartupLogInspector {
    enum FailureKind: Equatable {
        case portInUse
        case fatal(reason: String)
        case transient
    }

    static func classify(_ logSegment: String) -> FailureKind {
        if logSegment.contains("EADDRINUSE") {
            return .portInUse
        }
        if logSegment.contains("Cannot find module") || logSegment.contains("ERR_MODULE_NOT_FOUND") {
            return .fatal(reason: "内置运行时文件缺失或损坏，请重新安装 Zimlo。")
        }
        if logSegment.contains("SyntaxError") {
            return .fatal(reason: "本地配置或数据文件损坏，请打开日志定位后修复。")
        }
        return .transient
    }
}

/// 解析 `lsof -nP -iTCP:<port> -sTCP:LISTEN -F pc` 的输出，best-effort 识别端口占用者。
enum PortOwnerLookup {
    static func parse(_ output: String) -> (pid: String, command: String)? {
        var pid: String?
        var command: String?
        for line in output.split(separator: "\n") {
            if line.hasPrefix("p") {
                pid = String(line.dropFirst())
                command = nil
            } else if line.hasPrefix("c") {
                command = String(line.dropFirst())
            }
            if let pid, let command { return (pid, command) }
        }
        return nil
    }
}

/// 配对二维码有效期倒计时。
enum PairingCountdown {
    static func remainingSeconds(expiresAt: Date, now: Date) -> Int {
        max(0, Int(expiresAt.timeIntervalSince(now).rounded(.up)))
    }

    static func isExpired(expiresAt: Date, now: Date) -> Bool {
        expiresAt.timeIntervalSince(now) <= 0
    }
}

/// 菜单栏版本号：读 Bundle 的 CFBundleShortVersionString（+ build 号），不再硬编码。
enum AppVersion {
    static func display(shortVersion: String?, build: String?) -> String {
        guard let shortVersion, !shortVersion.isEmpty else { return "dev" }
        guard let build, !build.isEmpty else { return shortVersion }
        return "\(shortVersion) (\(build))"
    }

    static var display: String {
        let info = Bundle.main.infoDictionary
        return display(
            shortVersion: info?["CFBundleShortVersionString"] as? String,
            build: info?["CFBundleVersion"] as? String
        )
    }
}
