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
        XCTAssertTrue(snapshot.notificationSettings.results)
        XCTAssertFalse(snapshot.notificationSettings.criticalOnly)
        XCTAssertFalse(snapshot.notificationSettings.quietHoursEnabled)
        XCTAssertEqual(snapshot.notificationSettings.timeZoneOffsetMinutes, 0)
    }

    func testNotificationPolicyKeepsOneHighSignalAlertPerTask() {
        var previous = NativeSnapshot.empty
        previous.sessions = [session(projectID: nil, cwd: "/tmp/project")]
        previous.sequence = 1
        var next = previous
        next.sequence = 2
        next.posts = [
            feedPost(id: "progress-a", kind: "progress", createdAt: "2026-08-26T00:00:01Z"),
            feedPost(id: "result-a", kind: "result", createdAt: "2026-08-26T00:00:02Z"),
        ]
        next.actions = [PendingAction(
            actionId: "action-a", hostId: nil, sessionId: "session-a", upstreamRequestId: nil,
            kind: "approval", title: "允许执行？", detail: "git push", availableDecisions: [],
            expiresAt: "2099-01-01T00:00:00Z", state: "pending",
            createdAt: "2026-08-26T00:00:03Z", resolvedAt: nil, approvalContext: nil
        )]

        let candidates = MacNotificationPolicy.candidates(
            previous: previous,
            next: next,
            preferences: .defaults
        )
        XCTAssertEqual(candidates, [MacNotificationCandidate(
            id: "action:action-a",
            sessionID: "session-a",
            taskTitle: "修复一下",
            kind: .approval,
            occurredAt: "2026-08-26T00:00:03Z",
            summary: "需要批准一项操作"
        )])
        XCTAssertEqual(candidates.first?.notificationIdentifier, "zimlo.session.session-a.action")
        XCTAssertEqual(MacNotificationPolicy.unreadCount(snapshot: next, preferences: .defaults), 2)
    }

    func testNotificationIdentifiersKeepActionsSeparateFromTaskStatus() {
        let result = MacNotificationCandidate(
            id: "post:result-a", sessionID: "session-a", taskTitle: nil,
            kind: .result, occurredAt: "2026-08-26T00:00:01Z"
        )
        let failure = MacNotificationCandidate(
            id: "post:failure-a", sessionID: "session-a", taskTitle: nil,
            kind: .failure, occurredAt: "2026-08-26T00:00:02Z"
        )
        XCTAssertEqual(result.notificationIdentifier, "zimlo.session.session-a.status")
        XCTAssertEqual(failure.notificationIdentifier, result.notificationIdentifier)
    }

    func testNotificationSummariesUseEditorialAndStructuredContent() {
        XCTAssertEqual(
            MacNotificationPolicy.notificationSummary(
                headline: "通知系统完成",
                takeaway: "P1/P2 已完成，全部测试通过。"
            ),
            "通知系统完成：P1/P2 已完成，全部测试通过。"
        )
        let action = PendingAction(
            actionId: "action-a", hostId: nil, sessionId: "session-a", upstreamRequestId: nil,
            kind: "approval", title: "允许执行？", detail: "git push secret-value",
            availableDecisions: [], expiresAt: "2099-01-01T00:00:00Z", state: "pending",
            createdAt: "2026-08-26T00:00:03Z", resolvedAt: nil,
            approvalContext: ApprovalContext(
                category: "git_publish", projectId: nil, cwd: "/tmp/project",
                command: "git push secret-value", segments: ["git push secret-value"],
                withinProject: true, reason: "识别为 git_publish"
            )
        )
        XCTAssertEqual(MacNotificationPolicy.notificationSummary(action: action), "需要批准：发布 Git 变更")
        XCTAssertFalse(MacNotificationPolicy.notificationSummary(action: action).contains("secret-value"))
    }

    func testResolvedActionSessionsRemoveOnlyTheActionChannel() {
        var previous = NativeSnapshot.empty
        previous.actions = [PendingAction(
            actionId: "action-a", hostId: nil, sessionId: "session-a", upstreamRequestId: nil,
            kind: "approval", title: "允许执行？", detail: "git push", availableDecisions: [],
            expiresAt: "2099-01-01T00:00:00Z", state: "pending",
            createdAt: "2026-08-26T00:00:03Z", resolvedAt: nil, approvalContext: nil
        )]
        var next = previous
        next.actions[0].state = "resolved"

        XCTAssertEqual(
            MacNotificationPolicy.resolvedActionSessionIDs(previous: previous, next: next),
            Set(["session-a"])
        )
    }

    func testFailedTaskBecomesFallbackOnlyWhenNoFailurePostArrived() {
        var previous = NativeSnapshot.empty
        previous.sessions = [session(projectID: nil, cwd: "/tmp/project")]
        previous.tasks = [TaskRecord(
            id: "task-a", hostId: nil, runId: "run-a", agentId: "codex",
            sessionId: "session-a", state: "running", reason: "", updatedAt: "2026-08-26T00:00:01Z"
        )]
        var next = previous
        next.tasks[0].state = "failed"
        next.tasks[0].reason = "process exited"
        next.tasks[0].updatedAt = "2026-08-26T00:00:02Z"

        let candidates = MacNotificationPolicy.failureFallbackCandidates(
            previous: previous, next: next, preferences: .defaults
        )
        XCTAssertEqual(candidates.map(\.id), ["task:task-a"])
        XCTAssertEqual(candidates.first?.notificationIdentifier, "zimlo.session.session-a.status")

        next.posts = [feedPost(id: "failure-a", kind: "failure", createdAt: "2026-08-26T00:00:02Z")]
        XCTAssertTrue(MacNotificationPolicy.failureFallbackCandidates(
            previous: previous, next: next, preferences: .defaults
        ).isEmpty)
    }

    func testNotificationPolicyRespectsSeenResultsAndCategorySettings() {
        var previous = NativeSnapshot.empty
        previous.sessions = [session(projectID: nil, cwd: "/tmp/project")]
        var next = previous
        next.posts = [feedPost(id: "result-a", kind: "result", createdAt: "2026-08-26T00:00:02Z")]
        next.seenPostIds = ["result-a"]

        XCTAssertTrue(MacNotificationPolicy.candidates(
            previous: previous,
            next: next,
            preferences: .defaults
        ).isEmpty)
        XCTAssertEqual(MacNotificationPolicy.unreadCount(snapshot: next, preferences: .defaults), 0)

        next.seenPostIds = []
        var disabledResults = MacNotificationPreferences.defaults
        disabledResults.results = false
        XCTAssertTrue(MacNotificationPolicy.candidates(
            previous: previous,
            next: next,
            preferences: disabledResults
        ).isEmpty)
    }

    func testQuietHoursAndCriticalOnlyKeepOnlyCriticalNotifications() throws {
        var preferences = MacNotificationPreferences.defaults
        preferences.quietHoursEnabled = true
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
        let date = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-08-26T23:00:00Z"))
        XCTAssertFalse(MacNotificationPolicy.shouldDeliver(
            .result, preferences: preferences, date: date, calendar: calendar
        ))
        XCTAssertTrue(MacNotificationPolicy.shouldDeliver(
            .approval, preferences: preferences, date: date, calendar: calendar
        ))
        XCTAssertTrue(MacNotificationPolicy.shouldDeliver(
            .failure, preferences: preferences, date: date, calendar: calendar
        ))

        preferences.quietHoursEnabled = false
        preferences.criticalOnly = true
        XCTAssertFalse(MacNotificationPolicy.shouldDeliver(.result, preferences: preferences))
        XCTAssertTrue(MacNotificationPolicy.shouldDeliver(.approvalReminder, preferences: preferences))
    }

    func testApprovalReminderIsScheduledOnceNearExpiry() throws {
        let action = PendingAction(
            actionId: "action-a", hostId: nil, sessionId: "session-a", upstreamRequestId: nil,
            kind: "approval", title: "允许执行？", detail: "git push", availableDecisions: [],
            expiresAt: "2026-08-26T00:10:00.000Z", state: "pending",
            createdAt: "2026-08-26T00:00:00.000Z", resolvedAt: nil, approvalContext: nil
        )
        let now = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-08-26T00:00:00Z"))
        XCTAssertEqual(MacNotificationPolicy.approvalReminderDelay(action: action, now: now), 5 * 60)
        var resolved = action
        resolved.state = "resolved"
        XCTAssertNil(MacNotificationPolicy.approvalReminderDelay(action: resolved, now: now))
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

    func testFeedMaterialPresentationUsesInlineImagesForAlbums() {
        let album = FeedContent(
            type: "image_album",
            materialIds: ["material-image-a", "material-image-b"],
            materialId: nil,
            posterMaterialId: nil,
            coverMaterialId: nil,
            caption: "新版图标",
            summary: nil
        )
        XCTAssertEqual(
            NativeFeedMaterialPresentation(content: album),
            .imageAlbum(["material-image-a", "material-image-b"])
        )

        let text = FeedContent(
            type: "text",
            materialIds: nil,
            materialId: nil,
            posterMaterialId: nil,
            coverMaterialId: nil,
            caption: nil,
            summary: nil
        )
        XCTAssertEqual(NativeFeedMaterialPresentation(content: text), .none)
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

    private func feedPost(id: String, kind: String, createdAt: String) -> FeedPost {
        FeedPost(
            id: id, hostId: nil, projectId: nil, taskId: "task-a", runId: "run-a",
            agentId: "codex", sessionId: "session-a", kind: kind, template: "paper",
            headline: "结果", takeaway: "结果已经可以查看。", highlights: [], proof: nil,
            content: nil, dedupeKey: id, source: "agent", createdAt: createdAt
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
