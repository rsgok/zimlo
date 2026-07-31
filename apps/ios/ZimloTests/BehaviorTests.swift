import XCTest
@testable import Zimlo

final class ApprovalStateTests: XCTestCase {
    func testDoubleConfirmRequiresTwoDistinctInteractions() {
        var state = HighRiskApprovalState(requiredPhrase: "DELETE")
        XCTAssertEqual(state.phase, .needsFill)
        XCTAssertFalse(state.canSubmit)
        // 未填入短语时提交是空操作，保证两步缺一不可。
        XCTAssertNil(state.submit())
        XCTAssertEqual(state.phase, .needsFill)

        state.fillPhrase()
        XCTAssertEqual(state.phase, .readyToSubmit)
        XCTAssertTrue(state.canSubmit)

        XCTAssertEqual(state.submit(), "DELETE")
        XCTAssertEqual(state.phase, .submitted)
    }

    func testResetClearsPhrase() {
        var state = HighRiskApprovalState(requiredPhrase: "确认删除")
        state.fillPhrase()
        state.reset()
        XCTAssertNil(state.filledPhrase)
        XCTAssertEqual(state.phase, .needsFill)
        XCTAssertFalse(state.canSubmit)
        XCTAssertNil(state.submit())
    }

    func testFillTwiceIsIdempotent() {
        var state = HighRiskApprovalState(requiredPhrase: "YES")
        state.fillPhrase()
        state.fillPhrase()
        XCTAssertEqual(state.phase, .readyToSubmit)
        XCTAssertEqual(state.submit(), "YES")
    }
}

final class SnapshotCacheMigrationTests: XCTestCase {
    func testEnvelopeRoundTrip() throws {
        let envelope = CachedSnapshot(snapshot: .empty, savedAt: Date(timeIntervalSince1970: 1_700_000_000))
        let data = try JSONEncoder().encode(envelope)
        let decoded = try XCTUnwrap(SnapshotCache.decode(data))
        XCTAssertEqual(decoded.savedAt, envelope.savedAt)
        XCTAssertEqual(decoded.snapshot.sequence, 0)
    }

    func testLegacyBareSnapshotMigratesWithFileDate() throws {
        var legacy = Snapshot.empty
        legacy.sequence = 42
        let data = try JSONEncoder().encode(legacy)
        let modifiedAt = Date(timeIntervalSince1970: 1_600_000_000)
        let decoded = try XCTUnwrap(SnapshotCache.decode(data, fileModifiedAt: modifiedAt))
        XCTAssertEqual(decoded.snapshot.sequence, 42)
        XCTAssertEqual(decoded.savedAt, modifiedAt)
    }

    func testGarbageReturnsNil() {
        XCTAssertNil(SnapshotCache.decode(Data("not json".utf8)))
    }
}

@MainActor
final class OutboxFlowTests: XCTestCase {
    private let outboxKey = "zimlo.native.command-outbox.v1"

    override func setUp() {
        UserDefaults.standard.removeObject(forKey: outboxKey)
    }

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: outboxKey)
    }

    private func makeModel() -> AppModel { AppModel() }

    private func makePost(id: String) -> FeedPost {
        FeedPost(
            id: id, projectId: nil, taskId: "t1", runId: "r1", agentId: "a1",
            sessionId: "s1", kind: "progress", template: "", headline: "h",
            takeaway: "t", highlights: [], proof: nil, actionRequired: false,
            actionPrompt: nil, actions: [], pendingActionIds: [], dedupeKey: "",
            source: "test", createdAt: "2026-07-20T10:00:00.000Z"
        )
    }

    func testDismissAndUndoAreOptimisticAndQueued() {
        let model = makeModel()
        model.snapshot = .empty
        model.snapshot.posts = [makePost(id: "p1")]
        XCTAssertEqual(model.feedEntries.map(\.id), ["post:p1"])

        model.dismiss("post:p1")
        XCTAssertTrue(model.feedEntries.isEmpty, "移除乐观生效，卡片立刻消失")
        XCTAssertTrue(model.snapshot.dismissedFeedItemIds.contains("post:p1"))
        let dismissEntry = model.outboxEntries.first { $0.command.type == "feed.dismiss.set" }
        XCTAssertEqual(dismissEntry?.command.values["dismissed"], .bool(true))
        XCTAssertNotNil(model.noticeAction, "移除后提供撤销入口")

        model.undismiss("post:p1")
        XCTAssertEqual(model.feedEntries.map(\.id), ["post:p1"], "撤销乐观恢复")
        XCTAssertFalse(model.snapshot.dismissedFeedItemIds.contains("post:p1"))
        // 离线时 dismissed=false 条目留在 outbox 等待重放；在线时发送成功即清除。
        let undoEntry = model.outboxEntries.first { $0.command.type == "feed.dismiss.set" }
        XCTAssertEqual(undoEntry?.command.values["dismissed"], .bool(false))
    }

    func testDismissSetKeepsOnlyLatestStatePerItem() {
        let model = makeModel()
        model.dismiss("post:p1")
        model.undismiss("post:p1")
        let entries = model.outboxEntries.filter { $0.command.type == "feed.dismiss.set" }
        XCTAssertEqual(entries.count, 1, "同一 item 的 dismiss 状态覆盖，不叠加")
        XCTAssertEqual(entries.first?.command.values["dismissed"], .bool(false))
    }

    func testCancelQueuedFollowUp() {
        let model = makeModel()
        XCTAssertTrue(model.followUp(sessionId: "s1", text: "继续"))
        XCTAssertEqual(model.pendingOutboxCount, 1)
        let entry = model.outboxEntries[0]
        XCTAssertTrue(CommandCancelRules.isOutboxEntryCancelable(entry, snapshot: model.snapshot))
        XCTAssertTrue(model.cancelOutboxEntry(entry))
        XCTAssertEqual(model.pendingOutboxCount, 0)
    }

    func testCancelPersistsDistinctIntentWhenServerSnapshotHasNotArrived() {
        let model = makeModel()
        XCTAssertTrue(model.followUp(sessionId: "s1", text: "继续"))
        let original = model.outboxEntries[0]

        XCTAssertTrue(model.cancelOutboxEntry(original))
        XCTAssertEqual(model.pendingOutboxCount, 1)
        let cancellation = model.outboxEntries[0]
        XCTAssertEqual(cancellation.command.type, "task.command.cancel")
        XCTAssertNotEqual(cancellation.id, original.id)
        XCTAssertEqual(cancellation.command.values["idempotencyKey"], original.command.values["idempotencyKey"])
    }

    func testApprovalEntriesAreNotCancelable() {
        let model = makeModel()
        let action = PendingAction(
            actionId: "a1", sessionId: "s1", upstreamRequestId: nil, kind: "approval",
            title: "t", detail: "d", availableDecisions: [], expiresAt: "",
            state: "pending", createdAt: "", resolvedAt: nil, approvalContext: nil
        )
        model.decide(action: action, decision: Decision(
            id: "d1", label: "允许", scope: "once", value: .null,
            confirmationPhrase: nil, risk: "low"
        ))
        let entry = model.outboxEntries.first { $0.command.type == "action.decide" }
        XCTAssertNotNil(entry)
        XCTAssertFalse(CommandCancelRules.isOutboxEntryCancelable(entry!, snapshot: model.snapshot))
        XCTAssertFalse(model.cancelOutboxEntry(entry!), "审批类指令只展示，不可撤回")
    }

    func testFollowUpPersistsBeforeReportingSuccess() {
        let model = makeModel()
        XCTAssertTrue(model.followUp(sessionId: "s1", text: "  继续跑测试  "))
        let stored = UserDefaults.standard.data(forKey: outboxKey)
        XCTAssertNotNil(stored, "先持久化 outbox，调用方才能清空输入")
        let entries = try? JSONDecoder().decode([OutboxEntry].self, from: stored ?? Data())
        XCTAssertEqual(entries?.count, 1)
        XCTAssertEqual(entries?.first?.semanticKey, "task.follow_up:s1:继续跑测试")
    }
}

final class FeedCohortRulesTests: XCTestCase {
    private func entry(id: String, unread: Bool, needsAction: Bool, settled: Bool = false) -> FeedEntry {
        let post = FeedPost(
            id: id, projectId: nil, taskId: "t-\(id)", runId: "r1", agentId: "a1",
            sessionId: "s1", kind: "result", template: "paper", headline: id,
            takeaway: "", highlights: [], proof: nil, actionRequired: false,
            actionPrompt: nil, actions: [], pendingActionIds: [], dedupeKey: id,
            source: "test", createdAt: "2026-07-20T10:00:00.000Z"
        )
        return FeedEntry(
            id: "post:\(id)", createdAt: post.createdAt, needsAction: needsAction,
            unread: unread, settledReview: settled, priority: needsAction ? 0 : 2,
            sessionId: post.sessionId,
            content: .post(post)
        )
    }

    func testSettledCurrentCardKeepsItsSessionPosition() {
        let initial = [entry(id: "a", unread: true, needsAction: true), entry(id: "b", unread: true, needsAction: false)]
        let order = FeedCohortRules.reconcile(previous: [], entries: initial)
        let settled = [entry(id: "a", unread: false, needsAction: false, settled: true), initial[1]]
        XCTAssertEqual(FeedCohortRules.reconcile(previous: order, entries: settled), ["post:a", "post:b"])
    }

    func testHistoricalCardResurfacesWhenItBecomesActionable() {
        let history = entry(id: "history", unread: false, needsAction: false)
        XCTAssertEqual(FeedCohortRules.reconcile(previous: ["post:a"], entries: [entry(id: "a", unread: true, needsAction: false), history]), ["post:a"])
        let actionable = entry(id: "history", unread: false, needsAction: true)
        XCTAssertEqual(FeedCohortRules.reconcile(previous: ["post:a"], entries: [entry(id: "a", unread: true, needsAction: false), actionable]), ["post:a", "post:history"])
        XCTAssertNotEqual(FeedCohortRules.signature([history]), FeedCohortRules.signature([actionable]))
    }
}
