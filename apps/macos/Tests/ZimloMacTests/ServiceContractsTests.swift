import XCTest
@testable import ZimloMac

final class ManualStopMarkerTests: XCTestCase {
    private var directory: URL!
    private var marker: ManualStopMarker!

    override func setUp() {
        super.setUp()
        directory = FileManager.default.temporaryDirectory
            .appending(path: "zimlo-test-\(UUID().uuidString)", directoryHint: .isDirectory)
        marker = ManualStopMarker(url: directory.appending(path: "run/manual-stop"))
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
        super.tearDown()
    }

    func testSetClearRoundTrip() throws {
        XCTAssertFalse(marker.isSet)

        let stoppedAt = Date(timeIntervalSince1970: 1_700_000_000)
        marker.set(at: stoppedAt)
        XCTAssertTrue(marker.isSet)
        // 与 CLI markManualStop 的格式一致：一行 ISO 时间戳
        let content = try String(contentsOf: marker.url, encoding: .utf8)
        XCTAssertEqual(content, "\(stoppedAt.ISO8601Format())\n")

        marker.clear()
        XCTAssertFalse(marker.isSet)
        // 标记不存在时 clear 是幂等 no-op
        marker.clear()
        XCTAssertFalse(marker.isSet)
    }
}

final class AutoStartGateTests: XCTestCase {
    func testDecisionMatrix() {
        XCTAssertEqual(AutoStartGate.decide(recoveryHalted: false, manualStopSet: false), .proceed)
        XCTAssertEqual(AutoStartGate.decide(recoveryHalted: true, manualStopSet: false), .halted)
        XCTAssertEqual(AutoStartGate.decide(recoveryHalted: false, manualStopSet: true), .manualStopped)
        // 熔断/终止态优先于手动停止标记：保留更可操作的错误文案
        XCTAssertEqual(AutoStartGate.decide(recoveryHalted: true, manualStopSet: true), .halted)
    }
}

final class HealthCheckTests: XCTestCase {
    private func decode(_ json: String) -> HealthResponse? {
        try? JSONDecoder().decode(HealthResponse.self, from: Data(json.utf8))
    }

    func testProtocolVersionTwoIsCompatible() {
        let health = decode(#"{"ok":true,"version":"0.2.0","protocolVersion":2,"features":{}}"#)
        XCTAssertNotNil(health)
        XCTAssertTrue(HealthCheck.isCompatible(protocolVersion: health?.protocolVersion))
    }

    func testOlderOrMissingProtocolIsNotCompatible() {
        XCTAssertFalse(HealthCheck.isCompatible(protocolVersion: decode(#"{"ok":true,"protocolVersion":1}"#)?.protocolVersion))
        XCTAssertFalse(HealthCheck.isCompatible(protocolVersion: decode(#"{"ok":true}"#)?.protocolVersion))
        // protocolVersion 类型不对时整个 decode 失败，按不兼容处理
        XCTAssertNil(decode(#"{"ok":true,"protocolVersion":"2"}"#))
        XCTAssertFalse(HealthCheck.isCompatible(protocolVersion: nil))
    }
}

final class DesktopBridgeLaunchTests: XCTestCase {
    func testDesktopBridgeEnablesTrustedLANFallback() {
        let entrypoint = URL(fileURLWithPath: "/Applications/Zimlo.app/Contents/Resources/runtime/cli/dist/index.js")
        XCTAssertEqual(
            DesktopBridgeLaunch.arguments(entrypoint: entrypoint),
            ["--use-env-proxy", entrypoint.path, "start", "--lan"]
        )
    }
}

final class PairingAutostartPolicyTests: XCTestCase {
    func testCreatesOnlyAfterServiceBecomesReady() {
        XCTAssertFalse(PairingAutostartPolicy.shouldCreate(
            serviceState: .starting,
            hasPairing: false,
            isPaired: false
        ))
        XCTAssertTrue(PairingAutostartPolicy.shouldCreate(
            serviceState: .ready,
            hasPairing: false,
            isPaired: false
        ))
    }

    func testDoesNotReplaceExistingOrCompletedPairing() {
        XCTAssertFalse(PairingAutostartPolicy.shouldCreate(
            serviceState: .ready,
            hasPairing: true,
            isPaired: false
        ))
        XCTAssertFalse(PairingAutostartPolicy.shouldCreate(
            serviceState: .ready,
            hasPairing: false,
            isPaired: true
        ))
    }
}

final class SystemProxyEnvironmentTests: XCTestCase {
    func testMapsSystemHTTPProxyAndKeepsBridgeTrafficLocal() {
        let environment = SystemProxyEnvironment.environment(from: [
            "HTTPEnable": 1,
            "HTTPProxy": "127.0.0.1",
            "HTTPPort": 7897,
            "HTTPSEnable": 1,
            "HTTPSProxy": "127.0.0.1",
            "HTTPSPort": 7897,
            "ExceptionsList": ["192.168.0.0/16", "localhost", "<local>"],
        ])

        XCTAssertEqual(environment["HTTP_PROXY"], "http://127.0.0.1:7897")
        XCTAssertEqual(environment["HTTPS_PROXY"], "http://127.0.0.1:7897")
        XCTAssertEqual(environment["NO_PROXY"], "192.168.0.0/16,localhost,127.0.0.1,::1")
    }

    func testIgnoresDisabledOrMalformedProxySettings() {
        let environment = SystemProxyEnvironment.environment(from: [
            "HTTPEnable": 0,
            "HTTPProxy": "127.0.0.1",
            "HTTPPort": 7897,
            "HTTPSEnable": 1,
            "HTTPSProxy": "",
            "HTTPSPort": 0,
        ])

        XCTAssertNil(environment["HTTP_PROXY"])
        XCTAssertNil(environment["HTTPS_PROXY"])
        XCTAssertEqual(environment["NO_PROXY"], "127.0.0.1,localhost,::1")
    }
}

final class PairingPayloadTests: XCTestCase {
    func testDecodesLANTransport() throws {
        let payload = try JSONDecoder().decode(PairingPayload.self, from: Data(#"{"pairUrl":"http://192.168.1.8:4747/#pair","qrDataUrl":"data:image/png;base64,AA==","expiresAt":"2026-08-01T00:00:00.000Z","transport":"lan"}"#.utf8))
        XCTAssertEqual(payload.transport, .lan)
        XCTAssertNil(payload.localPairUrl)
    }

    func testDecodesCloudPayloadWithLocalFallback() throws {
        let payload = try JSONDecoder().decode(PairingPayload.self, from: Data(#"{"pairUrl":"https://cloud.example/#pair","localPairUrl":"http://192.168.1.8:4747/#pair","qrDataUrl":"data:image/png;base64,AA==","expiresAt":"2026-08-01T00:00:00.000Z","transport":"cloud"}"#.utf8))
        XCTAssertEqual(payload.transport, .cloud)
        XCTAssertEqual(payload.localPairUrl, "http://192.168.1.8:4747/#pair")
    }

    func testOlderBridgePayloadRemainsCompatible() throws {
        let payload = try JSONDecoder().decode(PairingPayload.self, from: Data(#"{"pairUrl":"https://cloud.example/#pair","qrDataUrl":"data:image/png;base64,AA==","expiresAt":"2026-08-01T00:00:00.000Z"}"#.utf8))
        XCTAssertNil(payload.transport)
    }
}

final class ServiceDescriptorTests: XCTestCase {
    private let fallback = "/Users/x/Library/Logs/Zimlo/service.log"

    private func descriptorJSON(logPath: String) -> String {
        #"{"pid":1234,"port":4747,"version":"0.2.0","protocolVersion":2,"startedAt":"2026-07-29T03:00:00.000Z","socketPath":"/Users/x/.zimlo/run/bridge.sock","logPath":\#(logPath)}"#
    }

    func testDecodesDescriptorWithLogPath() throws {
        let descriptor = ServiceDescriptor.decode(Data(descriptorJSON(logPath: #""/Users/x/.zimlo/logs/autostart.log""#).utf8))
        let value = try XCTUnwrap(descriptor)
        XCTAssertEqual(value.pid, 1234)
        XCTAssertEqual(value.port, 4747)
        XCTAssertEqual(value.protocolVersion, 2)
        XCTAssertEqual(value.logPath, "/Users/x/.zimlo/logs/autostart.log")
    }

    func testDecodesDescriptorWithNullLogPath() throws {
        let descriptor = try XCTUnwrap(ServiceDescriptor.decode(Data(descriptorJSON(logPath: "null").utf8)))
        XCTAssertNil(descriptor.logPath)
    }

    func testRejectsMalformedDescriptor() {
        XCTAssertNil(ServiceDescriptor.decode(Data(#"{"port":4747}"#.utf8)))
        XCTAssertNil(ServiceDescriptor.decode(Data("not json".utf8)))
    }

    func testResolvedLogPathPrefersDescriptorThenFallsBack() {
        let withLog = ServiceDescriptor.decode(Data(descriptorJSON(logPath: #""/Users/x/.zimlo/logs/autostart.log""#).utf8))
        XCTAssertEqual(ServiceDescriptor.resolvedLogPath(descriptor: withLog, fallback: fallback),
                       "/Users/x/.zimlo/logs/autostart.log")

        let nullLog = ServiceDescriptor.decode(Data(descriptorJSON(logPath: "null").utf8))
        XCTAssertEqual(ServiceDescriptor.resolvedLogPath(descriptor: nullLog, fallback: fallback), fallback)

        let emptyLog = ServiceDescriptor.decode(Data(descriptorJSON(logPath: #"""#).utf8))
        XCTAssertEqual(ServiceDescriptor.resolvedLogPath(descriptor: emptyLog, fallback: fallback), fallback)

        XCTAssertEqual(ServiceDescriptor.resolvedLogPath(descriptor: nil, fallback: fallback), fallback)
    }
}
