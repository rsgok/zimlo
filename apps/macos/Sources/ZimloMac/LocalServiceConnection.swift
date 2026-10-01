import Darwin
import Foundation

enum LocalServiceIdentityError: LocalizedError, Equatable {
    case unavailable
    case upgradeRequired
    case mismatch

    var errorDescription: String? {
        switch self {
        case .unavailable: "无法确认本机服务身份。请启动 Zimlo 后台后重试。"
        case .upgradeRequired: "后台服务需要更新才能核对设备身份。请在设置中停止服务，再启动新版后台。"
        case .mismatch: "连接的不是预期的本机服务，操作已暂停。请检查是否有容器或其他应用占用本机端口，然后重试。"
        }
    }
}

/// The expected identity comes from a private local file, never from whichever
/// server happens to answer on the port. Re-read it for each operation/restart.
enum LocalServiceIdentity {
    static var descriptorURL: URL {
        let root = ProcessInfo.processInfo.environment["ZIMLO_HOME"].map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appending(path: ".zimlo")
        return root.appending(path: "run/service.json")
    }

    static func load(from url: URL = descriptorURL) throws -> ServiceDescriptor {
        let fd = open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw LocalServiceIdentityError.unavailable }
        let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? file.close() }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_uid == getuid(),
              (info.st_mode & S_IFMT) == S_IFREG, (info.st_mode & 0o077) == 0,
              info.st_size > 0, info.st_size < 64 * 1024,
              let descriptor = ServiceDescriptor.decode(try file.readToEnd() ?? Data()),
              descriptor.pid > 1, descriptor.pid <= Int(Int32.max),
              kill(Int32(descriptor.pid), 0) == 0,
              (1...65_535).contains(descriptor.port),
              HealthCheck.isCompatible(protocolVersion: descriptor.protocolVersion) else {
            throw LocalServiceIdentityError.unavailable
        }
        guard let host = descriptor.hostId, !host.isEmpty,
              let instance = descriptor.instanceId, UUID(uuidString: instance) != nil else {
            throw LocalServiceIdentityError.upgradeRequired
        }
        return descriptor
    }

    static func verify(_ response: HTTPURLResponse, descriptor: ServiceDescriptor) throws {
        guard let host = descriptor.hostId, let instance = descriptor.instanceId else {
            throw LocalServiceIdentityError.upgradeRequired
        }
        guard response.url?.scheme == "http", response.url?.host == "127.0.0.1",
              response.url?.port == descriptor.port,
              response.value(forHTTPHeaderField: "X-Zimlo-Host-ID") == host,
              response.value(forHTTPHeaderField: "X-Zimlo-Instance-ID") == instance else {
            throw LocalServiceIdentityError.mismatch
        }
    }
}

struct LocalServiceConnection: Sendable {
    var descriptor: @Sendable () throws -> ServiceDescriptor = { try LocalServiceIdentity.load() }

    func data(for original: URLRequest, using session: URLSession) async throws -> (Data, URLResponse) {
        let expected = try descriptor()
        if let requestedHost = original.value(forHTTPHeaderField: "X-Zimlo-Host-ID"), requestedHost != expected.hostId {
            throw LocalServiceIdentityError.mismatch
        }
        let base = LocalBridgeRoute.resolve(descriptor: expected).baseURL
        var healthRequest = URLRequest(url: base.appending(path: "healthz"))
        healthRequest.timeoutInterval = 2
        let (healthData, healthResponse) = try await session.data(for: healthRequest, delegate: LocalServiceRedirectPolicy())
        guard let health = healthResponse as? HTTPURLResponse, health.statusCode == 200,
              HealthCheck.isCompatible(protocolVersion: try JSONDecoder().decode(HealthResponse.self, from: healthData).protocolVersion) else {
            throw LocalServiceIdentityError.mismatch
        }
        try LocalServiceIdentity.verify(health, descriptor: expected)
        if original.url?.path == "/healthz" { return (healthData, healthResponse) }

        var request = original
        guard var parts = URLComponents(url: original.url ?? base, resolvingAgainstBaseURL: false) else {
            throw LocalServiceIdentityError.unavailable
        }
        parts.scheme = "http"; parts.host = "127.0.0.1"; parts.port = expected.port
        request.url = parts.url
        request.setValue(expected.hostId, forHTTPHeaderField: "X-Zimlo-Host-ID")
        request.setValue(expected.instanceId, forHTTPHeaderField: "X-Zimlo-Instance-ID")
        let (data, response) = try await session.data(for: request, delegate: LocalServiceRedirectPolicy())
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        try LocalServiceIdentity.verify(http, descriptor: expected)
        let latest = try descriptor()
        guard latest.hostId == expected.hostId, latest.instanceId == expected.instanceId else {
            throw LocalServiceIdentityError.mismatch
        }
        return (data, response)
    }
}

/// A local endpoint must never forward a command or attachment to a different
/// origin through an HTTP redirect, even after a successful identity preflight.
private final class LocalServiceRedirectPolicy: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
