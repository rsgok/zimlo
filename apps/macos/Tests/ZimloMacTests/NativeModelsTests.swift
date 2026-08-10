import Foundation
import XCTest
@testable import ZimloMac

final class NativeModelsTests: XCTestCase {
    @MainActor
    func testOfficialProviderArtworkDecodesForBothRuntimes() {
        XCTAssertNotNil(NativeProviderAssets.image(for: .codex))
        XCTAssertNotNil(NativeProviderAssets.image(for: .claude))
    }

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

    func testFeedArchiveGestureRequiresACommittedLeftDrag() {
        XCTAssertEqual(
            NativeFeedArchiveGesture.horizontalOffset(for: CGSize(width: -90, height: 12)),
            -90
        )
        XCTAssertEqual(
            NativeFeedArchiveGesture.horizontalOffset(for: CGSize(width: 90, height: 4)),
            0
        )
        XCTAssertEqual(
            NativeFeedArchiveGesture.horizontalOffset(for: CGSize(width: -80, height: 78)),
            0
        )
        XCTAssertFalse(NativeFeedArchiveGesture.shouldArchive(
            translation: CGSize(width: -90, height: 5),
            predicted: CGSize(width: -120, height: 5)
        ))
        XCTAssertTrue(NativeFeedArchiveGesture.shouldArchive(
            translation: CGSize(width: -120, height: 5),
            predicted: CGSize(width: -130, height: 5)
        ))
        XCTAssertTrue(NativeFeedArchiveGesture.shouldArchive(
            translation: CGSize(width: -70, height: 5),
            predicted: CGSize(width: -190, height: 6)
        ))
    }

    func testTaskPresentationRemovesInternalResponseMetadata() {
        let value = """
        用户能看到的结论

        ::git-push{cwd="/tmp/repo" branch="main"}
        <oai-mem-citation><citation_entries>internal</citation_entries></oai-mem-citation>
        """
        XCTAssertEqual(TaskPresentationRules.clean(value), "用户能看到的结论")
    }

    func testTimelineExtractsUsefulPromptAndDeduplicatesCompletionEvents() throws {
        let prompt = try event(kind: "user_instruction", payload: .object([
            "prompt": .string("# Files mentioned by the user:\n\n## My request:\n修复 Feed 卡片\n<image path=\"shot.png\">")
        ]))
        XCTAssertEqual(TimelineEventPresentation.text(for: prompt), "修复 Feed 卡片")

        let first = try event(kind: "completed", payload: .object([
            "message": .array([.object(["type": .string("output_text"), "text": .string("已经完成并通过验证")])])
        ]))
        let duplicate = try event(kind: "completed", payload: .object([
            "type": .string("task_complete"), "last_agent_message": .string("已经完成并通过验证")
        ]), id: "event-b")
        XCTAssertEqual(TimelineEventPresentation.deduplicated([first, duplicate]).map(\.id), [first.id])
    }

    func testTimelineDropsMetadataOnlyCompletion() throws {
        let value = try event(kind: "completed", payload: .object(["type": .string("task_complete")]))
        XCTAssertNil(TimelineEventPresentation.text(for: value))
    }

    func testTaskProjectResolutionUsesTheDeepestMatchingWorkspacePath() {
        var snapshot = NativeSnapshot.empty
        snapshot.projects = [
            project(id: "repo", path: "/Code/zimlo"),
            project(id: "feature", path: "/Code/zimlo/apps/macos"),
        ]

        let session = session(projectID: nil, cwd: "/Code/zimlo/apps/macos/Sources")
        XCTAssertEqual(snapshot.project(for: session)?.id, "feature")
    }

    func testUnassignedRootTaskDoesNotBorrowAnUnrelatedProjectAvatar() {
        var snapshot = NativeSnapshot.empty
        snapshot.projects = [project(id: "repo", path: "/Code/zimlo")]

        XCTAssertNil(snapshot.project(for: session(projectID: nil, cwd: "/")))
    }

    private func project(id: String, path: String) -> Project {
        Project(
            id: id,
            hostId: "host-a",
            name: id,
            primaryPath: path,
            paths: [path],
            providers: [.codex],
            sessionCount: 1,
            postCount: 0,
            agentProfile: AgentProfile(
                displayName: id,
                avatar: "user-01",
                bio: "",
                defaultProvider: .codex,
                updatedAt: ""
            ),
            createdAt: "",
            lastUsedAt: ""
        )
    }

    private func event(kind: String, payload: JSONValue, id: String = "event-a") throws -> UnifiedEvent {
        UnifiedEvent(
            id: id, sequence: 1, provider: .codex, sessionId: "session-a",
            providerSessionId: "provider-a", turnId: nil, itemId: nil, kind: kind,
            source: "test", occurredAt: "2026-08-11T00:00:00.000Z", payload: payload,
            provenance: "test"
        )
    }

    private func session(projectID: String?, cwd: String) -> AgentSession {
        AgentSession(
            id: "session-a",
            hostId: "host-a",
            projectId: projectID,
            provider: .codex,
            surface: "gui",
            providerSessionId: "provider-a",
            title: "修复一下",
            projectName: nil,
            cwd: cwd,
            transcriptPath: nil,
            status: "running",
            lastActivityAt: "",
            createdAt: "",
            activePid: nil,
            processStartedAt: nil,
            tty: nil,
            correlationUncertain: false,
            capabilities: SessionCapabilities(
                discovered: true,
                liveObserved: true,
                replyable: true,
                approvableOnce: false,
                approvableSession: false,
                approvablePersistent: false,
                resumable: true,
                diffAvailable: false
            )
        )
    }
}
