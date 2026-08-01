import XCTest
@testable import ZimloMac

final class MainAppRouteTests: XCTestCase {
    func testUsesDefaultLoopbackURLWithoutDescriptor() {
        let route = MainAppRoute.resolve(descriptor: nil)

        XCTAssertEqual(
            route.url.absoluteString,
            "http://127.0.0.1:4747/?shell=macos&theme=dark"
        )
    }

    func testUsesCompatibleDescriptorPort() {
        let descriptor = ServiceDescriptor(
            pid: 123,
            port: 5252,
            version: "0.2.0",
            protocolVersion: 2,
            startedAt: "2026-08-01T00:00:00.000Z",
            socketPath: "/tmp/zimlo.sock",
            logPath: nil
        )

        XCTAssertEqual(MainAppRoute.resolve(descriptor: descriptor).url.port, 5252)
    }

    func testRejectsIncompatibleDescriptorPort() {
        let descriptor = ServiceDescriptor(
            pid: 123,
            port: 5252,
            version: "0.2.0",
            protocolVersion: 1,
            startedAt: "2026-08-01T00:00:00.000Z",
            socketPath: "/tmp/zimlo.sock",
            logPath: nil
        )

        XCTAssertEqual(MainAppRoute.resolve(descriptor: descriptor).url.port, 4747)
    }

    func testNavigationAllowsOnlyLocalHTTPOnConfiguredPort() throws {
        let route = MainAppRoute.resolve(descriptor: nil)

        XCTAssertTrue(route.allowsNavigation(to: try XCTUnwrap(URL(string: "http://127.0.0.1:4747/tasks/one"))))
        XCTAssertTrue(route.allowsNavigation(to: try XCTUnwrap(URL(string: "http://localhost:4747/feed"))))
        XCTAssertFalse(route.allowsNavigation(to: try XCTUnwrap(URL(string: "http://127.0.0.1:5252/"))))
        XCTAssertFalse(route.allowsNavigation(to: try XCTUnwrap(URL(string: "https://127.0.0.1:4747/"))))
        XCTAssertFalse(route.allowsNavigation(to: try XCTUnwrap(URL(string: "https://example.com/"))))
        XCTAssertFalse(route.allowsNavigation(to: try XCTUnwrap(URL(fileURLWithPath: "/tmp/index.html"))))
    }

    func testReloadRequestBypassesStaleDocumentCache() {
        let route = MainAppRoute.resolve(descriptor: nil)
        let reloadID = UUID(uuidString: "9BFBFAAF-721E-48C1-81B1-19C1A7C7565D")!
        let request = route.request(reloadID: reloadID)
        let components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)

        XCTAssertEqual(request.cachePolicy, .reloadIgnoringLocalAndRemoteCacheData)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Cache-Control"), "no-cache")
        XCTAssertEqual(
            components?.queryItems?.first(where: { $0.name == "desktopReload" })?.value,
            reloadID.uuidString
        )
    }
}
