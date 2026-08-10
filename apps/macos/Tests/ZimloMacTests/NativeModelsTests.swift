import Foundation
import XCTest
@testable import ZimloMac

final class NativeModelsTests: XCTestCase {
    func testSnapshotDecodesWithForwardCompatibleDefaults() throws {
        let data = Data("""
        {
          "userProfile": {"avatarId":"user-01","updatedAt":""},
          "projects":[],"sessions":[],"posts":[],"tasks":[],"commands":[],"workspaces":[],
          "seenPostIds":[],"dismissedFeedItemIds":[],"taskTimelineCursors":{},"taskPreferences":[],
          "actions":[],"trustPolicies":[],
          "notificationSettings":{"enabled":false,"approvals":true,"failures":true,"showTaskTitle":false,"updatedAt":""},
          "features":{"projectTrustPolicy":true,"pushNotifications":false,"remoteSync":false,"multiHost":true},
          "sequence":7,"lanApprovalsEnabled":false,"trustManagementEnabled":true,
          "unknownFutureField":{"safe":true}
        }
        """.utf8)

        let snapshot = try JSONDecoder().decode(NativeSnapshot.self, from: data)
        XCTAssertEqual(snapshot.sequence, 7)
        XCTAssertTrue(snapshot.materials.isEmpty)
        XCTAssertTrue(snapshot.features.projectTrustPolicy)
    }

    func testTaskPresentationKeepsConcreteStatusLabels() {
        XCTAssertEqual(TaskPresentationRules.stateLabel("user_review"), "待你审阅")
        XCTAssertEqual(TaskPresentationRules.stateLabel("waiting_input"), "等你回复")
        XCTAssertEqual(TaskPresentationRules.shortTitle("  这是一个  很长的任务标题  ", limit: 8), "这是一个 很长的…")
    }

    func testTaskPresentationRemovesInternalResponseMetadata() {
        let value = """
        用户能看到的结论

        ::git-push{cwd="/tmp/repo" branch="main"}
        <oai-mem-citation><citation_entries>internal</citation_entries></oai-mem-citation>
        """
        XCTAssertEqual(TaskPresentationRules.clean(value), "用户能看到的结论")
    }
}
