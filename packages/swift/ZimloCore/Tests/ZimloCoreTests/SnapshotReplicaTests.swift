import XCTest
@testable import ZimloCore

final class SnapshotReplicaTests: XCTestCase {
    func testSharedDeltaVectors() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appending(path: "../../../../protocol/test-vectors/snapshot-delta.json")
        let cases = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [[String: Any]])
        for item in cases {
            var replica = SnapshotReplica()
            let full = try JSONSerialization.data(withJSONObject: item["full"]!)
            guard case .message(_, let negotiate) = replica.receive(full, hostID: "mac") else { return XCTFail("Full snapshot rejected") }
            XCTAssertTrue(negotiate)
            let patch = try JSONSerialization.data(withJSONObject: item["patch"]!)
            let result = replica.receive(patch, hostID: "mac")
            if item["expected"] is NSNull {
                guard case .resync = result else { return XCTFail("Unsafe patch accepted") }
            } else {
                guard case .message(let data, let negotiate) = result else { return XCTFail("Valid patch rejected") }
                XCTAssertFalse(negotiate)
                let message = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
                XCTAssertEqual(message["snapshot"] as? NSDictionary, item["expected"] as? NSDictionary)
            }
        }
    }
}
