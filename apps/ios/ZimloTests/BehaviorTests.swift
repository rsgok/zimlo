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

    func testApprovalExpiryUsesDeadlineAndRoundsPartialSecondsUp() {
        let now = Date(timeIntervalSince1970: 1_000)
        let expiry = ApprovalExpiry(deadline: now.addingTimeInterval(90.2))

        XCTAssertFalse(expiry.isExpired(at: now))
        XCTAssertEqual(expiry.remainingSeconds(at: now), 91)
        XCTAssertEqual(expiry.label(at: now), "1 分 31 秒后失效")
        XCTAssertEqual(expiry.remainingSeconds(at: expiry.deadline), 0)
        XCTAssertTrue(expiry.isExpired(at: expiry.deadline))
        XCTAssertEqual(expiry.label(at: expiry.deadline), "审批已失效")
    }
}

final class MaterialPolicyTests: XCTestCase {
    func testUsesTightPerTypeLimits() {
        XCTAssertEqual(MaterialPolicy.kind(mimeType: "image/png", name: "shot.png")?.limit, 8 * 1_024 * 1_024)
        XCTAssertEqual(MaterialPolicy.kind(mimeType: "video/mp4", name: "clip.mp4")?.limit, 50 * 1_024 * 1_024)
        XCTAssertEqual(MaterialPolicy.kind(mimeType: "application/pdf", name: "report.pdf")?.limit, 20 * 1_024 * 1_024)
        XCTAssertNil(MaterialPolicy.kind(mimeType: "application/x-mach-binary", name: "tool"))
    }

    func testRejectsOversizedImagesBeforeEncryption() async {
        do {
            _ = try await MaterialPolicy.prepare(
                data: Data(repeating: 0, count: 8 * 1_024 * 1_024 + 1),
                name: "too-large.png", mimeType: "image/png"
            )
            XCTFail("Expected image limit failure")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("8MB"))
        }
    }

    func testNormalizesGenericOfficeMIMEBeforeRegistration() async throws {
        let prepared = try await MaterialPolicy.prepare(
            data: Data([0x50, 0x4b]),
            name: "brief.docx", mimeType: "application/octet-stream"
        )
        defer { try? FileManager.default.removeItem(at: prepared.localURL) }
        XCTAssertEqual(
            prepared.material.mimeType,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        )
    }
}

final class PairingLinkRulesTests: XCTestCase {
    func testAcceptsOnlyCompleteHTTPPairingLinks() {
        let valid = "https://relay.example/#pairingId=p1&secret=s1&bridgeKey=k1"
        XCTAssertEqual(PairingLinkRules.validatedURL("  \(valid)\n")?.absoluteString, valid)

        XCTAssertNil(PairingLinkRules.validatedURL("zimlo://pair/#pairingId=p1&secret=s1&bridgeKey=k1"))
        XCTAssertNil(PairingLinkRules.validatedURL("https://relay.example/#pairingId=p1&secret=s1"))
        XCTAssertNil(PairingLinkRules.validatedURL("https://relay.example/#pairingId=&secret=s1&bridgeKey=k1"))
        XCTAssertNil(PairingLinkRules.validatedURL("https://relay.example/"))
    }

    func testLocalPairingFailuresExplainPermissionAndOfferSettings() {
        let local = PairingLinkRules.validatedURL(
            "http://192.168.1.20:4747/#pairingId=p1&secret=s1&bridgeKey=k1"
        )
        let error = "The request timed out."
        XCTAssertTrue(PairingNetworkRules.usesLocalNetwork(local))
        XCTAssertEqual(PairingNetworkRules.protocolProbeTimeout(for: local!), 20)
        XCTAssertTrue(PairingNetworkRules.shouldOfferSettings(error: error, pairingURL: local))
        XCTAssertTrue(PairingNetworkRules.userFacingError(error, pairingURL: local).contains("本地网络"))
    }

    func testCloudPairingTimeoutDoesNotSuggestLocalNetworkSettings() {
        let cloud = PairingLinkRules.validatedURL(
            "https://relay.example/#pairingId=p1&secret=s1&bridgeKey=k1"
        )
        let error = "The request timed out."
        XCTAssertFalse(PairingNetworkRules.usesLocalNetwork(cloud))
        XCTAssertEqual(PairingNetworkRules.protocolProbeTimeout(for: cloud!), 5)
        XCTAssertFalse(PairingNetworkRules.shouldOfferSettings(error: error, pairingURL: cloud))
    }
}

final class BridgeErrorPresentationRulesTests: XCTestCase {
    func testSuccessfulReconnectClearsAStaleTransportError() {
        XCTAssertNil(BridgeErrorPresentationRules.aggregate(
            current: "There was a bad response from the server.",
            connected: true,
            channelErrors: [nil]
        ))
    }

    func testDisconnectedStateKeepsAnActionableError() {
        XCTAssertEqual(BridgeErrorPresentationRules.aggregate(
            current: nil,
            connected: false,
            channelErrors: ["Mac 当前离线"]
        ), "Mac 当前离线")
        XCTAssertEqual(BridgeErrorPresentationRules.aggregate(
            current: "无法安全保存这台 Mac 的连接信息",
            connected: false,
            channelErrors: []
        ), "无法安全保存这台 Mac 的连接信息")
    }
}

final class PhoneSetupRulesTests: XCTestCase {
    func testOnlyFirstUnpairedLaunchAutomaticallyShowsSetup() {
        XCTAssertEqual(
            PhoneSetupRules.root(pairingRequired: true, hasEverPaired: false, dismissed: false),
            .firstRun
        )
        XCTAssertEqual(
            PhoneSetupRules.root(pairingRequired: false, hasEverPaired: false, dismissed: false),
            .appShell
        )
    }

    func testSkippingOrHavingPairedKeepsLaterLaunchesInAppShell() {
        XCTAssertEqual(
            PhoneSetupRules.root(pairingRequired: true, hasEverPaired: false, dismissed: true),
            .appShell
        )
        XCTAssertEqual(
            PhoneSetupRules.root(pairingRequired: true, hasEverPaired: true, dismissed: false),
            .appShell
        )
    }

    func testMacDownloadUsesStableReleaseRedirect() {
        XCTAssertEqual(
            PhoneSetupRules.macDownloadURL.absoluteString,
            "https://zimlo-cloud.zimlo.workers.dev/releases/macos/download"
        )
    }
}

final class TaskHeaderRulesTests: XCTestCase {
    func testNavigationTitleUsesFirstConciseClauseWhileTaskInputStaysComplete() {
        let input = "下一周我要对这个产品做宣发，包括在小红书上和 X 上，所以需要准备完整宣发材料"
        XCTAssertEqual(
            TaskHeaderRules.navigationTitle(sessionTitle: input, taskInput: input),
            "下一周我要对这个产品做宣发"
        )
    }

    func testNavigationTitleKeepsAConciseAuthoredTitle() {
        XCTAssertEqual(
            TaskHeaderRules.navigationTitle(sessionTitle: "产品宣发准备", taskInput: "准备一整套跨平台产品宣发材料"),
            "产品宣发准备"
        )
    }

    func testRequiredActionOnlyAppearsForRealUserWork() {
        XCTAssertNil(TaskHeaderRules.requiredAction(currentState: "idle", pendingActionTitle: nil, hasLatestConclusion: true))
        XCTAssertNil(TaskHeaderRules.requiredAction(currentState: "running", pendingActionTitle: nil, hasLatestConclusion: true))
        XCTAssertEqual(
            TaskHeaderRules.requiredAction(currentState: "user_review", pendingActionTitle: nil, hasLatestConclusion: true),
            "审阅最新结论"
        )
        XCTAssertEqual(
            TaskHeaderRules.requiredAction(currentState: "waiting_input", pendingActionTitle: nil, hasLatestConclusion: false),
            "回复 Agent，让任务继续"
        )
        XCTAssertEqual(
            TaskHeaderRules.requiredAction(currentState: "running", pendingActionTitle: "允许执行测试", hasLatestConclusion: true),
            "允许执行测试"
        )
    }

    func testStateLabelsNeverExposeProtocolValues() {
        XCTAssertEqual(TaskHeaderRules.stateLabel("idle"), "可继续")
        XCTAssertEqual(TaskHeaderRules.stateLabel("user_review"), "待你审阅")
    }
}

final class CoreActionMotionRulesTests: XCTestCase {
    func testComposerAndOfflineStatesTakePriorityOverAmbientMotion() {
        XCTAssertEqual(
            state(connected: true, composing: true, taskStates: ["running"]),
            .composing
        )
        XCTAssertEqual(
            state(connected: false, taskStates: ["running"]),
            .offline
        )
    }

    func testAttentionStatesOverrideRunningWork() {
        XCTAssertEqual(
            state(connected: true, pendingActionCount: 1, taskStates: ["running"]),
            .attention
        )
        XCTAssertEqual(
            state(connected: true, taskStates: ["user_review"]),
            .attention
        )
        XCTAssertEqual(
            state(connected: true, commandStates: ["failed"]),
            .attention
        )
    }

    func testActiveAndIdleStatesReflectRealWork() {
        XCTAssertEqual(state(connected: true, taskStates: ["running"]), .active)
        XCTAssertEqual(state(connected: true, commandStates: ["queued"]), .active)
        XCTAssertEqual(state(connected: true, pendingOutboxCount: 1), .active)
        XCTAssertEqual(state(connected: true), .idle)
    }

    private func state(
        connected: Bool,
        composing: Bool = false,
        pendingActionCount: Int = 0,
        failedOutboxCount: Int = 0,
        pendingOutboxCount: Int = 0,
        taskStates: [String] = [],
        commandStates: [String] = []
    ) -> CoreActionMotionState {
        CoreActionMotionRules.state(
            connected: connected,
            isComposerPresented: composing,
            pendingActionCount: pendingActionCount,
            failedOutboxCount: failedOutboxCount,
            pendingOutboxCount: pendingOutboxCount,
            taskStates: taskStates,
            commandStates: commandStates
        )
    }
}

final class OutboxFeedbackRulesTests: XCTestCase {
    func testBackgroundReadAndSettingsSyncStaySilent() {
        for type in ["feed.seen", "task.timeline.seen", "notification.device.register", "trust.policy.update", "material.register"] {
            XCTAssertNil(OutboxFeedbackRules.queuedNotice(commandType: type, sent: true))
            XCTAssertNil(OutboxFeedbackRules.duplicateNotice(commandType: type))
        }
    }

    func testBackgroundSyncDoesNotEnterGlobalPendingStatus() {
        for type in ["feed.seen", "task.timeline.seen", "feed.dismiss.set", "notification.device.register", "material.register"] {
            XCTAssertFalse(OutboxFeedbackRules.showsPendingStatus(commandType: type))
        }
        XCTAssertTrue(OutboxFeedbackRules.showsPendingStatus(commandType: "task.create"))
        XCTAssertTrue(OutboxFeedbackRules.showsPendingStatus(commandType: "trust.policy.update"))
    }

    func testUserAuthoredCommandsUseHumanFacingCopy() {
        XCTAssertEqual(OutboxFeedbackRules.queuedNotice(commandType: "task.create", sent: true), "任务已发送，等待 Mac 接收")
        XCTAssertEqual(OutboxFeedbackRules.queuedNotice(commandType: "task.follow_up", sent: true), "回复已发送，等待 Mac 接收")
        XCTAssertEqual(OutboxFeedbackRules.queuedNotice(commandType: "action.decide", sent: true), "决定已发送，等待 Mac 确认")
        XCTAssertEqual(OutboxFeedbackRules.queuedNotice(commandType: "task.create", sent: false), "已保存在手机，连接 Mac 后自动发送")
    }
}

final class SpeechCaptureErrorRulesTests: XCTestCase {
    func testSimulatorRecognizerFailureExplainsHowToRestoreAudioInput() {
        let message = SpeechCaptureErrorRules.message(for: "Failed to initialize recognizer", isSimulator: true)
        XCTAssertTrue(message.contains("Audio Input"))
        XCTAssertTrue(message.contains("真机"))
    }

    func testUnrelatedRecognizerErrorIsPreserved() {
        XCTAssertEqual(
            SpeechCaptureErrorRules.message(for: "No speech was detected", isSimulator: true),
            "No speech was detected"
        )
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

final class NotificationDeviceAcknowledgementRulesTests: XCTestCase {
    private func entry(type: String) -> OutboxEntry {
        OutboxEntry(
            id: type,
            semanticKey: type,
            command: ClientCommand(type: type, ["idempotencyKey": .string(type)]),
            enqueuedAt: "2026-08-01T00:00:00Z",
            lastError: nil
        )
    }

    private let registration = PushDeviceRegistration(
        deviceId: "phone", platform: "ios", endpoint: "apns://phone", publicKey: "pk",
        active: true, registeredAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z"
    )

    func testRegisterRequiresNonNilAuthoritativeRegistration() {
        let register = entry(type: "notification.device.register")
        XCTAssertTrue(NotificationDeviceAcknowledgementRules.confirms(register, registration: registration))
        XCTAssertFalse(NotificationDeviceAcknowledgementRules.confirms(register, registration: nil))
    }

    func testUnregisterRequiresAuthoritativeNullRegistration() {
        let unregister = entry(type: "notification.device.unregister")
        XCTAssertTrue(NotificationDeviceAcknowledgementRules.confirms(unregister, registration: nil))
        XCTAssertFalse(NotificationDeviceAcknowledgementRules.confirms(unregister, registration: registration))
    }

    func testRevocationRetryWaitsForAnyDeduplicatedUnregister() {
        let staleAttempt = entry(type: "notification.device.unregister")
        XCTAssertTrue(NotificationDeviceRevocationRules.hasPendingUnregister([staleAttempt]))
        XCTAssertFalse(NotificationDeviceRevocationRules.hasPendingUnregister([]))
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
            takeaway: "t", highlights: [], proof: nil, dedupeKey: "",
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
        // dismissed=false 始终留在 outbox，直到权威 snapshot 确认服务端已撤销移除。
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

    func testUndoDismissWaitsForAuthoritativeSnapshot() throws {
        let model = makeModel()
        model.undismiss("post:p1")
        let entry = try XCTUnwrap(model.outboxEntries.first)

        var stillDismissed = Snapshot.empty
        stillDismissed.dismissedFeedItemIds = ["post:p1"]
        XCTAssertFalse(FeedDismissAcknowledgementRules.snapshotConfirmsUndo(entry, snapshot: stillDismissed))

        var confirmed = Snapshot.empty
        confirmed.dismissedFeedItemIds = []
        XCTAssertTrue(FeedDismissAcknowledgementRules.snapshotConfirmsUndo(entry, snapshot: confirmed))
    }

    func testRepeatedNoticeGetsAFullNewLifetime() {
        let model = makeModel()
        model.showNotice("已移出 Feed")
        let firstGeneration = model.noticeGeneration
        model.showNotice("已移出 Feed")

        XCTAssertGreaterThan(model.noticeGeneration, firstGeneration)
        model.clearNotice(expectedGeneration: firstGeneration)
        XCTAssertEqual(model.notice, "已移出 Feed", "旧计时任务不能清掉同文案的新提示")
    }

    func testFeedReadReceiptQueuesSilentlyWithoutGlobalPendingStatus() {
        let model = makeModel()

        model.markSeen("p1")

        XCTAssertEqual(model.outboxEntries.map(\.command.type), ["feed.seen"])
        XCTAssertEqual(model.pendingOutboxCount, 0)
        XCTAssertEqual(model.waitingOutboxCount, 0)
        XCTAssertNil(model.notice)
    }

    func testCancelQueuedFollowUp() {
        let model = makeModel()
        XCTAssertTrue(model.followUp(sessionId: "s1", text: "继续"))
        XCTAssertEqual(model.pendingOutboxCount, 1)
        let entry = model.outboxEntries[0]
        XCTAssertTrue(CommandCancelRules.isOutboxEntryCancelable(entry, snapshot: model.snapshot))
        XCTAssertTrue(model.cancelOutboxEntry(entry))
        XCTAssertFalse(model.outboxEntries.contains { $0.id == entry.id }, "原指令应从 outbox 移除")
        XCTAssertEqual(model.pendingOutboxCount, 1, "撤回意图必须留在 outbox，等待 Bridge 确认")
        XCTAssertEqual(model.outboxEntries.first?.command.type, "task.command.cancel")
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

    func testCorrelatedServerErrorMarksOnlyTheRejectedEntry() throws {
        let model = makeModel()
        model.updateTrustPolicy(projectId: "project-missing-1", preset: "safe_automation")
        model.updateTrustPolicy(projectId: "project-missing-2", preset: "ask")
        let rejected = try XCTUnwrap(model.outboxEntries.first {
            $0.command.values["projectId"] == .string("project-missing-1")
        })

        XCTAssertTrue(model.markOutboxFailed(
            code: "project_not_found",
            error: "这个 Project 已不存在。",
            idempotencyKey: rejected.command.idempotencyKey,
            hostId: "host-1"
        ))
        XCTAssertEqual(model.failedOutboxCount, 1)
        XCTAssertEqual(model.waitingOutboxCount, 1)
        XCTAssertEqual(model.outboxEntries.first { $0.id == rejected.id }?.lastError, "这个 Project 已不存在。")
        XCTAssertNil(model.outboxEntries.first {
            $0.command.values["projectId"] == .string("project-missing-2")
        }?.lastError)
    }

    func testLegacyProjectNotFoundSafelyMatchesOneStaleEntry() {
        let model = makeModel()
        model.updateTrustPolicy(projectId: "project-legacy", preset: "safe_automation")

        XCTAssertTrue(model.markOutboxFailed(
            code: "project_not_found",
            error: "这个 Project 已不存在。",
            idempotencyKey: nil,
            hostId: "host-1"
        ))
        XCTAssertEqual(model.failedOutboxCount, 1)
        XCTAssertEqual(model.waitingOutboxCount, 0)
    }

    func testLegacyProjectNotFoundDoesNotGuessBetweenMultipleEntries() {
        let model = makeModel()
        model.updateTrustPolicy(projectId: "project-legacy-1", preset: "safe_automation")
        model.updateTrustPolicy(projectId: "project-legacy-2", preset: "ask")

        XCTAssertFalse(model.markOutboxFailed(
            code: "project_not_found",
            error: "这个 Project 已不存在。",
            idempotencyKey: nil,
            hostId: "host-1"
        ))
        XCTAssertEqual(model.failedOutboxCount, 0)
        XCTAssertEqual(model.waitingOutboxCount, 2)
    }

    func testManualRetryReturnsFailedEntryToWaiting() throws {
        let model = makeModel()
        model.updateTrustPolicy(projectId: "project-missing", preset: "safe_automation")
        let entry = try XCTUnwrap(model.outboxEntries.first)
        XCTAssertTrue(model.markOutboxFailed(
            code: "project_not_found",
            error: "这个 Project 已不存在。",
            idempotencyKey: entry.command.idempotencyKey,
            hostId: "host-1"
        ))

        model.retryOutboxEntry(entry)
        XCTAssertEqual(model.failedOutboxCount, 0)
        XCTAssertEqual(model.waitingOutboxCount, 1)
    }
}

final class FeedCohortRulesTests: XCTestCase {
    private func entry(id: String, unread: Bool, needsAction: Bool, settled: Bool = false) -> FeedEntry {
        let post = FeedPost(
            id: id, projectId: nil, taskId: "t-\(id)", runId: "r1", agentId: "a1",
            sessionId: "s1", kind: "result", template: "paper", headline: id,
            takeaway: "", highlights: [], proof: nil, dedupeKey: id,
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

    func testBeginningTargetUsesFirstAttentionCardOrCaughtUpPage() {
        XCTAssertEqual(FeedCohortRules.beginningTarget(currentOrder: ["post:a", "post:b"]), "post:a")
        XCTAssertEqual(FeedCohortRules.beginningTarget(currentOrder: []), FeedCohortRules.caughtUpID)
    }

    func testHistoricalCardResurfacesWhenItBecomesActionable() {
        let history = entry(id: "history", unread: false, needsAction: false)
        XCTAssertEqual(FeedCohortRules.reconcile(previous: ["post:a"], entries: [entry(id: "a", unread: true, needsAction: false), history]), ["post:a"])
        let actionable = entry(id: "history", unread: false, needsAction: true)
        XCTAssertEqual(FeedCohortRules.reconcile(previous: ["post:a"], entries: [entry(id: "a", unread: true, needsAction: false), actionable]), ["post:a", "post:history"])
        XCTAssertNotEqual(FeedCohortRules.signature([history]), FeedCohortRules.signature([actionable]))
    }

    func testCaughtUpSurfacesNewActionBeforeOrdinaryUpdate() {
        let update = entry(id: "update", unread: true, needsAction: false)
        let approval = entry(id: "approval", unread: false, needsAction: true)
        XCTAssertEqual(
            FeedCohortRules.arrivalTarget(
                visibleID: FeedCohortRules.caughtUpID,
                previous: ["post:old"],
                next: ["post:old", update.id, approval.id],
                entries: [update, approval]
            ),
            approval.id
        )
    }

    func testCaughtUpSurfacesOrdinaryNewUpdate() {
        let update = entry(id: "update", unread: true, needsAction: false)
        XCTAssertEqual(
            FeedCohortRules.arrivalTarget(
                visibleID: FeedCohortRules.caughtUpID,
                previous: [],
                next: [update.id],
                entries: [update]
            ),
            update.id
        )
    }

    func testArrivalDoesNotMoveAReaderOrRepeatAnExistingCard() {
        let update = entry(id: "update", unread: true, needsAction: false)
        XCTAssertNil(FeedCohortRules.arrivalTarget(
            visibleID: "post:reading",
            previous: [],
            next: [update.id],
            entries: [update]
        ))
        XCTAssertNil(FeedCohortRules.arrivalTarget(
            visibleID: FeedCohortRules.caughtUpID,
            previous: [update.id],
            next: [update.id],
            entries: [update]
        ))
    }
}

final class BridgeConnectionLeaseRulesTests: XCTestCase {
    func testStaleAuthenticationAndMessagesAreRejectedAfterReconnect() {
        XCTAssertFalse(BridgeConnectionLeaseRules.accepts(
            expectedGeneration: 7,
            currentGeneration: 8,
            intentionallyStopped: false
        ))
        XCTAssertTrue(BridgeConnectionLeaseRules.accepts(
            expectedGeneration: 8,
            currentGeneration: 8,
            intentionallyStopped: false
        ))
    }

    func testLateMessagesAreRejectedAfterForgetOrStop() {
        XCTAssertFalse(BridgeConnectionLeaseRules.accepts(
            expectedGeneration: 8,
            currentGeneration: 8,
            intentionallyStopped: true
        ))
    }
}

final class DateParsingPerformanceTests: XCTestCase {
    func testParsesFractionalAndWholeSecondISO8601Dates() {
        let fractional = "2026-08-01T00:00:00.123Z".zimloDate
        let wholeSecond = "2026-08-01T00:00:00Z".zimloDate
        let offsetWholeSecond = "2026-08-01T08:00:00+08:00".zimloDate
        let offsetFractional = "2026-08-01T08:00:00.123+08:00".zimloDate

        XCTAssertNotEqual(fractional, .distantPast)
        XCTAssertNotEqual(wholeSecond, .distantPast)
        XCTAssertEqual(fractional.timeIntervalSince(wholeSecond), 0.123, accuracy: 0.001)
        XCTAssertEqual(offsetWholeSecond, wholeSecond)
        XCTAssertEqual(offsetFractional, fractional)
        XCTAssertEqual("not-a-date".zimloDate, .distantPast)
    }
}

final class TaskDirectoryProjectionTests: XCTestCase {
    func testProjectionIndexesRelationsCollapsesFiltersAndSortsOnce() throws {
        var snapshot = Snapshot.empty
        snapshot.projects = [project(id: "p1", name: "项目一")]
        snapshot.sessions = [
            session(id: "s1", title: "Codex · CLI", projectID: "p1", status: "running", lastActivity: "2026-08-01T00:04:00Z"),
            session(id: "s2", title: "置顶任务", status: "waiting", lastActivity: "2026-08-01T00:03:00Z"),
            session(id: "s3", title: "归档任务", status: "completed", lastActivity: "2026-08-01T00:02:00Z"),
            session(id: "process-old", title: "进程任务", status: "running", lastActivity: "2026-08-01T00:01:00Z", createdAt: "2026-08-01T00:00:00Z", providerSessionID: "process:1", cwd: "/tmp/shared"),
            session(id: "process-new", title: "重复进程", status: "running", lastActivity: "2026-08-01T00:05:00Z", createdAt: "2026-08-01T00:01:00Z", providerSessionID: "process:2", cwd: "/tmp/shared"),
        ]
        snapshot.tasks = [
            TaskRecord(id: "old", runId: "r1", agentId: "a", sessionId: "s1", state: "running", reason: "旧标题", updatedAt: "2026-08-01T00:00:00Z"),
            TaskRecord(id: "new", runId: "r1", agentId: "a", sessionId: "s1", state: "waiting_input", reason: "需要确认。", updatedAt: "2026-08-01T00:01:00Z"),
        ]
        snapshot.taskPreferences = [
            TaskPreference(sessionId: "s2", pinnedAt: "2026-08-01T00:00:00Z", archivedAt: nil),
            TaskPreference(sessionId: "s3", pinnedAt: nil, archivedAt: "2026-08-01T00:00:00Z"),
        ]

        let active = TaskDirectoryProjection(snapshot: snapshot, search: "", filter: "全部")
        let attention = try XCTUnwrap(active.sections.first { $0.id == "待你处理" })
        XCTAssertEqual(attention.rows.map(\.id), ["s2", "s1"])
        XCTAssertEqual(attention.rows.last?.state, "waiting_input")
        XCTAssertEqual(attention.rows.last?.title, "需要确认")
        XCTAssertEqual(attention.rows.last?.projectName, "项目一")
        XCTAssertFalse(active.sections.flatMap(\.rows).contains { $0.id == "s3" })
        XCTAssertTrue(active.sections.flatMap(\.rows).contains { $0.id == "process-old" })
        XCTAssertFalse(active.sections.flatMap(\.rows).contains { $0.id == "process-new" })

        let archived = TaskDirectoryProjection(snapshot: snapshot, search: "归档", filter: "已归档")
        XCTAssertEqual(archived.sections.flatMap(\.rows).map(\.id), ["s3"])
    }

    func testAgentDetailProjectionBuildsActivityAndSessionSummaryOnce() {
        var snapshot = Snapshot.empty
        var agentProject = project(id: "p1", name: "项目一")
        agentProject.paths = [agentProject.primaryPath, "/tmp/p1-secondary", ""]
        snapshot.projects = [agentProject]
        snapshot.sessions = [
            session(id: "s1", title: "普通任务", projectID: "p1", status: "running", lastActivity: "2026-08-01T00:03:00Z"),
            session(id: "process-old", title: "进程任务", projectID: "p1", status: "running", lastActivity: "2026-08-01T00:02:00Z", createdAt: "2026-08-01T00:01:00Z", providerSessionID: "process:1", cwd: "/tmp/shared"),
            session(id: "process-new", title: "重复进程", projectID: "p1", status: "running", lastActivity: "2026-08-01T00:04:00Z", createdAt: "2026-08-01T00:02:00Z", providerSessionID: "process:2", cwd: "/tmp/shared"),
            session(id: "other", title: "其他项目", projectID: "p2", status: "running", lastActivity: "2026-08-01T00:05:00Z"),
        ]
        snapshot.posts = (0..<10).map { index in
            post(id: "p\(index)", projectID: "p1", createdAt: String(format: "2026-08-01T00:%02d:00Z", index))
        } + [post(id: "other", projectID: "p2", createdAt: "2026-08-01T00:59:00Z")]

        let collapsed = AgentDetailProjection(snapshot: snapshot, project: agentProject, showAllActivity: false)
        XCTAssertEqual(collapsed.managedSessions.map(\.id), ["s1", "process-old"])
        XCTAssertEqual(collapsed.runningCount, 2)
        XCTAssertEqual(collapsed.posts.map(\.id), (0..<10).reversed().map { "p\($0)" })
        XCTAssertEqual(collapsed.visiblePosts.count, 3)
        XCTAssertEqual(collapsed.remainingPostCount, 7)
        XCTAssertEqual(collapsed.workspacePaths, ["/tmp/p1", "/tmp/p1-secondary"])

        let expanded = AgentDetailProjection(snapshot: snapshot, project: agentProject, showAllActivity: true)
        XCTAssertEqual(expanded.visiblePosts.count, 10)
        XCTAssertEqual(expanded.remainingPostCount, 0)
    }

    private func project(id: String, name: String) -> Project {
        Project(
            id: id, name: name, primaryPath: "/tmp/\(id)", paths: ["/tmp/\(id)"],
            providers: [.codex], sessionCount: 1, postCount: 0,
            agentProfile: AgentProfile(displayName: name, avatar: "", bio: "", defaultProvider: .codex, updatedAt: ""),
            createdAt: "2026-08-01T00:00:00Z", lastUsedAt: "2026-08-01T00:00:00Z"
        )
    }

    private func session(
        id: String,
        title: String,
        projectID: String? = nil,
        status: String,
        lastActivity: String,
        createdAt: String = "2026-08-01T00:00:00Z",
        providerSessionID: String? = nil,
        cwd: String? = nil
    ) -> AgentSession {
        AgentSession(
            id: id, projectId: projectID, provider: .codex, surface: "cli",
            providerSessionId: providerSessionID ?? "provider:\(id)", title: title, projectName: nil,
            cwd: cwd, transcriptPath: nil, status: status, lastActivityAt: lastActivity,
            createdAt: createdAt, activePid: nil, processStartedAt: nil, tty: nil,
            correlationUncertain: false,
            capabilities: SessionCapabilities(
                discovered: true, liveObserved: true, replyable: true,
                approvableOnce: true, approvableSession: true, approvablePersistent: true,
                resumable: true, diffAvailable: true
            )
        )
    }

    private func post(id: String, projectID: String, createdAt: String) -> FeedPost {
        FeedPost(
            id: id, projectId: projectID, taskId: "task-\(id)", runId: "run-\(id)",
            agentId: "agent", sessionId: "s1", kind: "progress", template: "paper",
            headline: id, takeaway: id, highlights: [], proof: nil,
            dedupeKey: id, source: "test", createdAt: createdAt
        )
    }
}

final class EventBufferRulesTests: XCTestCase {
    func testLongTimelineRetainsOriginalInstructionAndLatestEvents() {
        var events = [event(id: "input", sequence: 0, kind: "user_instruction", text: "原始任务")]
        events += (1...501).map { sequence in
            event(id: "event-\(sequence)", sequence: sequence, kind: "plan_updated", text: "步骤 \(sequence)")
        }

        let bounded = EventBufferRules.bounded(events)

        XCTAssertEqual(bounded.count, EventBufferRules.timelineLimit + 1)
        XCTAssertEqual(bounded.first?.id, "input")
        XCTAssertFalse(bounded.contains { $0.id == "event-1" })
        XCTAssertEqual(bounded.last?.id, "event-501")
    }

    private func event(id: String, sequence: Int, kind: String, text: String) -> UnifiedEvent {
        UnifiedEvent(
            id: id, sequence: sequence, provider: .codex, sessionId: "s1",
            providerSessionId: "provider-s1", turnId: nil, itemId: nil,
            kind: kind, source: "test", occurredAt: "2026-08-01T00:00:00Z",
            payload: .string(text), provenance: "test"
        )
    }
}

final class TaskDetailProjectionTests: XCTestCase {
    func testCancelledReadDelayDoesNotMarkTaskAsReadable() async {
        let delay = Task { await TimelineReadDelay.wait(for: .seconds(30)) }
        delay.cancel()

        let completed = await delay.value
        XCTAssertFalse(completed)
    }

    func testProjectionDeduplicatesInstructionsAndIndexesDetailsWithStableIDs() {
        var snapshot = Snapshot.empty
        snapshot.commands = [command(id: "c1", text: "继续")]
        let events = [
            event(id: "e1", sequence: 1, turnID: "turn-1", kind: "user_instruction", text: "继续"),
            event(id: "e2", sequence: 2, turnID: "turn-1", kind: "plan_updated", text: "拆分步骤"),
            event(id: "e3", sequence: 3, kind: "user_instruction", text: "跑测试"),
            event(id: "e4", sequence: 4, kind: "tests_passed", text: "全部通过"),
            event(id: "e5", sequence: 5, kind: "user_instruction", text: "汇总"),
            event(id: "e6", sequence: 6, kind: "completed", text: "完成报告"),
        ]

        let first = TaskDetailProjection(
            snapshot: snapshot,
            session: session(),
            sessionEvents: events,
            localFollowUps: []
        )
        let second = TaskDetailProjection(
            snapshot: snapshot,
            session: session(),
            sessionEvents: events,
            localFollowUps: []
        )

        XCTAssertEqual(first.timelineItems.map(\.id), second.timelineItems.map(\.id))
        XCTAssertTrue(first.timelineItems.contains { $0.id == "command:c1" })
        XCTAssertFalse(first.timelineItems.contains { $0.id == "event:e1" })
        XCTAssertEqual(first.detailsByItemID["command:c1"], ["计划：拆分步骤"])
        XCTAssertEqual(first.detailsByItemID["event:e3"], ["验证：全部通过"])
        XCTAssertEqual(first.detailsByItemID["event:e5"], ["完成：完成报告"])
    }

    private func session() -> AgentSession {
        AgentSession(
            id: "s1", projectId: nil, provider: .codex, surface: "cli",
            providerSessionId: "provider-s1", title: "测试任务", projectName: nil,
            cwd: "/tmp/project", transcriptPath: nil, status: "running",
            lastActivityAt: "2026-08-01T00:00:00Z", createdAt: "2026-08-01T00:00:00Z",
            activePid: nil, processStartedAt: nil, tty: nil, correlationUncertain: false,
            capabilities: SessionCapabilities(
                discovered: true, liveObserved: true, replyable: true,
                approvableOnce: true, approvableSession: true, approvablePersistent: true,
                resumable: true, diffAvailable: true
            )
        )
    }

    private func command(id: String, text: String) -> TaskCommand {
        TaskCommand(
            id: id, idempotencyKey: id, kind: "follow_up", provider: .codex,
            sessionId: "s1", workspaceId: nil, cwd: "/tmp/project", text: text,
            state: "queued", createdAt: "2026-08-01T00:00:07Z",
            updatedAt: "2026-08-01T00:00:07Z", error: nil
        )
    }

    private func event(
        id: String,
        sequence: Int,
        turnID: String? = nil,
        kind: String,
        text: String
    ) -> UnifiedEvent {
        UnifiedEvent(
            id: id, sequence: sequence, provider: .codex, sessionId: "s1",
            providerSessionId: "provider-s1", turnId: turnID, itemId: nil,
            kind: kind, source: "test",
            occurredAt: "2026-08-01T00:00:0\(sequence)Z",
            payload: .string(text), provenance: "test"
        )
    }
}
