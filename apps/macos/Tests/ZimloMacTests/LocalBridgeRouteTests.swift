import XCTest
@testable import ZimloMac

final class LocalBridgeRouteTests: XCTestCase {
    func testUsesDefaultLoopbackURLWithoutDescriptor() {
        XCTAssertEqual(
            LocalBridgeRoute.resolve(descriptor: nil).baseURL.absoluteString,
            "http://127.0.0.1:4747"
        )
    }

    func testUsesCompatibleDescriptorPort() {
        let descriptor = ServiceDescriptor(
            pid: 123,
            port: 5252,
            version: "0.2.0",
            protocolVersion: 5,
            startedAt: "2026-08-01T00:00:00.000Z",
            socketPath: "/tmp/zimlo.sock",
            logPath: nil
        )
        XCTAssertEqual(LocalBridgeRoute.resolve(descriptor: descriptor).baseURL.port, 5252)
    }

    func testRejectsIncompatibleOrInvalidDescriptorPort() {
        let incompatible = ServiceDescriptor(
            pid: 123,
            port: 5252,
            version: "0.2.0",
            protocolVersion: 1,
            startedAt: "2026-08-01T00:00:00.000Z",
            socketPath: "/tmp/zimlo.sock",
            logPath: nil
        )
        let invalid = ServiceDescriptor(
            pid: 123,
            port: 70_000,
            version: "0.2.0",
            protocolVersion: 5,
            startedAt: "2026-08-01T00:00:00.000Z",
            socketPath: "/tmp/zimlo.sock",
            logPath: nil
        )
        XCTAssertEqual(LocalBridgeRoute.resolve(descriptor: incompatible).baseURL.port, 4747)
        XCTAssertEqual(LocalBridgeRoute.resolve(descriptor: invalid).baseURL.port, 4747)
    }
}
