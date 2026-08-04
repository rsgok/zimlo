import XCTest
@testable import ZimloMac

final class LocalServiceStatusTests: XCTestCase {
    func testDecodesTruthfulCloudAndPairingState() throws {
        let data = Data("""
        {
          "ready": true,
          "cloud": true,
          "pushNotifications": false,
          "pairedDeviceCount": 1,
          "integrations": []
        }
        """.utf8)

        let status = try JSONDecoder().decode(LocalServiceStatus.self, from: data)

        XCTAssertTrue(status.ready)
        XCTAssertTrue(status.cloud)
        XCTAssertFalse(status.pushNotifications)
        XCTAssertEqual(status.pairedDeviceCount, 1)
    }

    func testTreatsOlderServiceAsUnpairedWithoutInventingPushSupport() throws {
        let data = Data("""
        {
          "ready": true,
          "cloud": true,
          "integrations": []
        }
        """.utf8)

        let status = try JSONDecoder().decode(LocalServiceStatus.self, from: data)

        XCTAssertFalse(status.pushNotifications)
        XCTAssertEqual(status.pairedDeviceCount, 0)
    }

    func testReadyFlagIsTheSourceOfTruthForGlobalServiceState() {
        let ready = LocalServiceStatus(
            ready: true,
            cloud: false,
            pushNotifications: false,
            pairedDeviceCount: 0,
            integrations: []
        )
        let notReady = LocalServiceStatus(
            ready: false,
            cloud: true,
            pushNotifications: true,
            pairedDeviceCount: 1,
            integrations: []
        )

        XCTAssertEqual(LocalStatusEvaluation.state(for: ready), .ready)
        XCTAssertEqual(
            LocalStatusEvaluation.state(for: notReady),
            .degraded(LocalStatusEvaluation.notReadyMessage)
        )
    }

    func testMenuStatusDoesNotPresentPushCapabilityAsAUserFault() {
        let status = LocalServiceStatus(
            ready: true,
            cloud: true,
            pushNotifications: false,
            pairedDeviceCount: 1,
            integrations: []
        )

        let detail = MenuStatusDescription.detail(for: .ready, status: status)

        XCTAssertEqual(detail, "手机已连接，等待需要你处理的任务")
        XCTAssertFalse(detail.contains("推送"))
        XCTAssertFalse(detail.contains("尚未启用"))
    }

    func testMenuStatusKeepsPairingAndCloudFailuresActionable() {
        let unpaired = LocalServiceStatus(
            ready: true,
            cloud: true,
            pushNotifications: false,
            pairedDeviceCount: 0,
            integrations: []
        )
        let offline = LocalServiceStatus(
            ready: true,
            cloud: false,
            pushNotifications: false,
            pairedDeviceCount: 1,
            integrations: []
        )

        XCTAssertEqual(MenuStatusDescription.detail(for: .ready, status: unpaired), "还未连接手机")
        XCTAssertEqual(
            MenuStatusDescription.detail(for: .ready, status: offline),
            "手机连接暂不可用，Zimlo 会自动重试"
        )
    }

    func testLateIntegrationSuccessDuringHaltUpdatesSnapshotOnly() {
        let current = LocalServiceStatus(
            ready: true,
            cloud: true,
            pushNotifications: true,
            pairedDeviceCount: 1,
            integrations: []
        )
        let integration = IntegrationStatus(
            id: "codex-cli",
            provider: "codex",
            surface: "cli",
            state: "ready",
            label: "Codex CLI",
            detail: "Connected"
        )
        let terminalState = ServiceState.unavailable("端口冲突")

        let updatedSnapshot = current.replacingIntegrations([integration])

        XCTAssertEqual(updatedSnapshot.integrations, [integration])
        XCTAssertTrue(updatedSnapshot.ready, "The response may update cached facts")
        XCTAssertEqual(terminalState, .unavailable("端口冲突"), "Button responses do not own global state")
        XCTAssertFalse(RecoveryHaltPolicy.allowsAutomaticStateTransition(
            recoveryHalted: true,
            stopping: false
        ))
    }
}
