import XCTest
@testable import ZimloMac

final class LocalServiceIdentityTests: XCTestCase {
    func testPrivateDescriptorIsRequiredAndLegacyRecordsFailClosed() throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let url = folder.appending(path: "service.json")
        let value: [String: Any] = [
            "pid": Int(getpid()), "port": 4747, "version": "0.2.1", "protocolVersion": 5,
            "startedAt": "2026-09-05T00:00:00Z", "socketPath": "/tmp/test.sock",
            "hostId": "mac", "instanceId": UUID().uuidString,
        ]
        try JSONSerialization.data(withJSONObject: value).write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        XCTAssertEqual(try LocalServiceIdentity.load(from: url).hostId, "mac")
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: url.path)
        XCTAssertThrowsError(try LocalServiceIdentity.load(from: url))
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        let symlink = folder.appending(path: "link.json")
        try FileManager.default.createSymbolicLink(at: symlink, withDestinationURL: url)
        XCTAssertThrowsError(try LocalServiceIdentity.load(from: symlink))
        var legacy = value
        legacy.removeValue(forKey: "instanceId")
        try JSONSerialization.data(withJSONObject: legacy).write(to: url)
        XCTAssertThrowsError(try LocalServiceIdentity.load(from: url)) { error in
            XCTAssertEqual(error as? LocalServiceIdentityError, .upgradeRequired)
        }
    }

    func testWrongHostCannotReceiveCommandBodyEvenWithCompatibleProtocol() async throws {
        let expected = identityDescriptor()
        IdentityHTTPStub.state.configure { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: [
                "X-Zimlo-Host-ID": "linux", "X-Zimlo-Instance-ID": expected.instanceId!,
            ])!, Data(#"{"protocolVersion":5}"#.utf8))
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [IdentityHTTPStub.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let connection = LocalServiceConnection(descriptor: { expected })
        var request = URLRequest(url: URL(string: "http://127.0.0.1:4747/api/local/commands")!)
        request.httpMethod = "POST"
        request.httpBody = Data("private command".utf8)
        do {
            _ = try await connection.data(for: request, using: session)
            XCTFail("Wrong host must fail")
        } catch { XCTAssertEqual(error as? LocalServiceIdentityError, .mismatch) }
        XCTAssertEqual(IdentityHTTPStub.state.paths, ["/healthz"])
    }

    func testChangedInstanceCannotPassResponseValidation() {
        let expected = identityDescriptor()
        let response = HTTPURLResponse(url: URL(string: "http://127.0.0.1:4747/healthz")!,
            statusCode: 200, httpVersion: nil, headerFields: [
                "X-Zimlo-Host-ID": "mac", "X-Zimlo-Instance-ID": UUID().uuidString,
            ])!
        XCTAssertThrowsError(try LocalServiceIdentity.verify(response, descriptor: expected)) { error in
            XCTAssertEqual(error as? LocalServiceIdentityError, .mismatch)
        }
    }

    func testMatchingHeadersFromARedirectedOriginCannotPassValidation() {
        let expected = identityDescriptor()
        let response = HTTPURLResponse(url: URL(string: "http://other-host.invalid:4747/healthz")!,
            statusCode: 200, httpVersion: nil, headerFields: [
                "X-Zimlo-Host-ID": expected.hostId!, "X-Zimlo-Instance-ID": expected.instanceId!,
            ])!
        XCTAssertThrowsError(try LocalServiceIdentity.verify(response, descriptor: expected)) { error in
            XCTAssertEqual(error as? LocalServiceIdentityError, .mismatch)
        }
    }

    func testPinnedHostFromPendingCommandCannotFollowAChangedDescriptor() async {
        let expected = identityDescriptor()
        IdentityHTTPStub.state.configure { _ in fatalError("Must not reach the network") }
        var request = URLRequest(url: URL(string: "http://127.0.0.1:4747/api/local/commands")!)
        request.setValue("old-host", forHTTPHeaderField: "X-Zimlo-Host-ID")
        do {
            _ = try await LocalServiceConnection(descriptor: { expected }).data(for: request, using: .shared)
            XCTFail("Command changed host")
        } catch { XCTAssertEqual(error as? LocalServiceIdentityError, .mismatch) }
        XCTAssertTrue(IdentityHTTPStub.state.paths.isEmpty)
    }
}

private func identityDescriptor() -> ServiceDescriptor {
    ServiceDescriptor(pid: Int(getpid()), port: 4747, version: "0.2.1", protocolVersion: 5,
                      startedAt: "", socketPath: "/tmp/socket", logPath: nil, hostId: "mac", instanceId: UUID().uuidString)
}

private final class IdentityHTTPStub: URLProtocol, @unchecked Sendable {
    static let state = IdentityHTTPState()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (response, data) = Self.state.respond(request)
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private final class IdentityHTTPState: @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [String] = []
    private var handler: (@Sendable (URLRequest) -> (HTTPURLResponse, Data))?
    var paths: [String] { lock.withLock { requests } }
    func configure(_ handler: @escaping @Sendable (URLRequest) -> (HTTPURLResponse, Data)) {
        lock.withLock { self.handler = handler; requests = [] }
    }
    func respond(_ request: URLRequest) -> (HTTPURLResponse, Data) {
        let callback = lock.withLock { requests.append(request.url?.path ?? ""); return handler! }
        return callback(request)
    }
}
