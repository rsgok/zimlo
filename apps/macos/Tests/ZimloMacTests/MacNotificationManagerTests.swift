import Foundation
import UserNotifications
import XCTest
@testable import ZimloMac

@MainActor
final class MacNotificationManagerTests: XCTestCase {
    func testDeniedAuthorizationKeepsUserNotificationIntent() async throws {
        let (defaults, suiteName) = try makeDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set(false, forKey: "zimlo.notifications.enabled.v1")
        let provider = FakeNotificationAuthorizationProvider(status: .denied)
        let manager = MacNotificationManager(center: provider, defaults: defaults)

        let allowed = await manager.setEnabled(true)

        XCTAssertFalse(allowed)
        XCTAssertTrue(manager.preferences.enabled)
        XCTAssertTrue(defaults.bool(forKey: "zimlo.notifications.enabled.v1"))
        XCTAssertEqual(manager.authorization, .denied)
        XCTAssertFalse(manager.effectiveEnabled)
    }

    func testRefreshRestoresEffectiveNotificationsWithoutRequestingPermission() async throws {
        let (defaults, suiteName) = try makeDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let provider = FakeNotificationAuthorizationProvider(status: .denied)
        let manager = MacNotificationManager(center: provider, defaults: defaults)

        await manager.refreshAuthorization()
        XCTAssertEqual(manager.authorizationLabel, "系统已拒绝")
        XCTAssertFalse(manager.effectiveEnabled)
        XCTAssertEqual(provider.requestCount, 0)

        provider.status = .authorized
        await manager.refreshAuthorization()

        XCTAssertEqual(manager.authorizationLabel, "系统已允许")
        XCTAssertTrue(manager.preferences.enabled)
        XCTAssertTrue(manager.effectiveEnabled)
        XCTAssertEqual(provider.requestCount, 0)
    }

    func testNotDeterminedAuthorizationRequestsOnceAndBecomesEffective() async throws {
        let (defaults, suiteName) = try makeDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let provider = FakeNotificationAuthorizationProvider(status: .notDetermined)
        provider.requestResult = true
        let manager = MacNotificationManager(center: provider, defaults: defaults)

        let allowed = await manager.setEnabled(true)

        XCTAssertTrue(allowed)
        XCTAssertEqual(provider.requestCount, 1)
        XCTAssertEqual(manager.authorization, .authorized)
        XCTAssertTrue(manager.effectiveEnabled)
    }

    private func makeDefaults() throws -> (UserDefaults, String) {
        let suiteName = "MacNotificationManagerTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        return (defaults, suiteName)
    }
}

@MainActor
private final class FakeNotificationAuthorizationProvider: MacNotificationCenterProviding {
    var status: MacNotificationAuthorization
    var requestResult = false
    private(set) var requestCount = 0
    var delegate: UNUserNotificationCenterDelegate?

    init(status: MacNotificationAuthorization) {
        self.status = status
    }

    func currentStatus() async -> MacNotificationAuthorization {
        status
    }

    func requestAuthorization() async -> Bool {
        requestCount += 1
        status = requestResult ? .authorized : .denied
        return requestResult
    }

    func removeDeliveredNotifications(withIdentifiers identifiers: [String]) {}

    func add(_ request: UNNotificationRequest) async throws {}
}
