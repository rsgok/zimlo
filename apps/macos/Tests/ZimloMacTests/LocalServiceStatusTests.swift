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
}
