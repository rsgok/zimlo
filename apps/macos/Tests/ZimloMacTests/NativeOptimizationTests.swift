import XCTest
@testable import ZimloMac

@MainActor
final class NativeSpeechLifecycleTests: XCTestCase {
    func testClosingTextOnlyComposerDoesNotInitializeAudioHardware() {
        let speech = NativeSpeechRecognizer(makeAudioEngine: {
            XCTFail("Text-only editing must not initialize audio hardware")
            fatalError("Unexpected microphone access")
        })
        speech.stop()
        speech.stop()
        XCTAssertEqual(speech.state, .idle)
    }
}

final class NativeFeedSequenceTests: XCTestCase {
    func testApprovalWithoutAnyPostIsShownAndSettlesInPlace() {
        var snapshot = fixtureSnapshot()
        snapshot.actions = [fixtureAction("a"), fixtureAction("b")]
        var sequence = NativeFeedSequence()
        sequence.reconcile(snapshot)
        XCTAssertEqual(sequence.entries.map(\.id), ["action:a", "action:b"])
        snapshot.actions = [fixtureAction("b")]
        sequence.reconcile(snapshot)
        XCTAssertEqual(sequence.entries.map(\.id), ["action:a", "action:b"])
        guard case .action(let action) = sequence.entries[0] else { return XCTFail("Missing settled approval") }
        XCTAssertEqual(action.state, "settled")
    }

    func testReadingAndRefreshDoNotReorderExistingCards() {
        var snapshot = fixtureSnapshot()
        snapshot.posts = [fixturePost("first", at: "2026-09-05T02:00:00Z"), fixturePost("second", at: "2026-09-05T01:00:00Z")]
        var sequence = NativeFeedSequence()
        sequence.reconcile(snapshot)
        let initial = sequence.entries.map(\.id)
        snapshot.seenPostIds = ["first"]
        sequence.reconcile(snapshot)
        XCTAssertEqual(sequence.entries.map(\.id), initial)
        snapshot.actions = [fixtureAction("urgent")]
        sequence.reconcile(snapshot)
        XCTAssertEqual(sequence.entries.map(\.id), ["action:urgent"] + initial)
        XCTAssertEqual(sequence.fresh, ["action:urgent"])
        sequence.clearFresh()
        XCTAssertTrue(sequence.fresh.isEmpty)
    }

    func testDismissAndHostChangeCannotLeaveOtherHostsCards() {
        var snapshot = fixtureSnapshot()
        snapshot.posts = [fixturePost("first"), fixturePost("second")]
        var sequence = NativeFeedSequence()
        sequence.reconcile(snapshot)
        snapshot.dismissedFeedItemIds = ["post:first"]
        sequence.reconcile(snapshot)
        XCTAssertEqual(sequence.entries.map(\.id), ["post:second"])
        snapshot.host?.id = "other"
        snapshot.posts = []
        sequence.reconcile(snapshot)
        XCTAssertTrue(sequence.entries.isEmpty)
        XCTAssertTrue(sequence.fresh.isEmpty)
    }

    func testRoutineMergeDoesNotExtendItsSixHourWindow() {
        var snapshot = fixtureSnapshot()
        snapshot.posts = [
            fixturePost("new", kind: "progress", at: "2026-09-05T12:00:00Z"),
            fixturePost("middle", kind: "progress", at: "2026-09-05T07:00:00Z"),
            fixturePost("old", kind: "progress", at: "2026-09-05T02:00:00Z"),
        ]
        XCTAssertEqual(NativeFeedPolicy.candidates(snapshot).map(\.id), ["post:new", "post:old"])
    }
}

@MainActor
final class NativeCommandOutboxTests: XCTestCase {
    func testLostReceiptSurvivesRestartAndKeepsOriginalKey() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let storage = NativeOutboxStorage.file(at: directory.appending(path: "outbox.json"))
        let original = fixtureCommand(key: "same-intent")
        let first = NativeCommandOutbox(storage: storage)
        XCTAssertTrue(first.enqueue(original, hostID: "mac"))
        var sent: [ClientCommand] = []
        await first.flush(snapshot: fixtureSnapshot(), send: {
            sent.append($0)
            throw URLError(.networkConnectionLost)
        }, received: { _ in XCTFail("No receipt expected") })
        XCTAssertEqual(first.entries.first?.state, .sent)
        XCTAssertFalse(try XCTUnwrap(first.entries.first).canWithdrawLocally)

        let restored = NativeCommandOutbox(storage: storage)
        XCTAssertEqual(restored.entries.count, 1)
        restored.retry(try XCTUnwrap(restored.entries.first?.id))
        await restored.flush(snapshot: fixtureSnapshot(), send: {
            sent.append($0)
            return LocalCommandResponse(ok: true, messages: [], snapshot: fixtureSnapshot())
        }, received: { _ in })
        XCTAssertEqual(sent.count, 2)
        XCTAssertEqual(sent[0], sent[1])
        XCTAssertEqual(sent[1].values["idempotencyKey"], .string("same-intent"))
        XCTAssertEqual(sent[1].values["hostId"], .string("mac"))
        XCTAssertTrue(restored.entries.isEmpty)
        XCTAssertTrue(try storage.read().isEmpty)
    }

    func testSnapshotAcknowledgesDeviceScopedKeyWithoutResending() async {
        let box = MemoryOutbox()
        let outbox = NativeCommandOutbox(storage: box.storage)
        XCTAssertTrue(outbox.enqueue(fixtureCommand(key: "receipt"), hostID: "mac"))
        var snapshot = fixtureSnapshot()
        snapshot.commands = [TaskCommand(id: "server-command", hostId: "mac", idempotencyKey: "local-device:receipt",
            kind: "create", provider: .codex, sessionId: nil, workspaceId: "workspace", cwd: "/project", text: "test",
            materialIds: [], state: "queued", createdAt: "", updatedAt: "", error: nil)]
        await outbox.flush(snapshot: snapshot, send: { _ in
            XCTFail("Already received commands must not be sent again")
            throw URLError(.cancelled)
        }, received: { _ in })
        XCTAssertTrue(outbox.entries.isEmpty)
    }

    func testAnotherHostCannotReceiveOrAcknowledgeThisCommand() async {
        let box = MemoryOutbox()
        let outbox = NativeCommandOutbox(storage: box.storage)
        XCTAssertTrue(outbox.enqueue(fixtureCommand(key: "one"), hostID: "mac"))
        var other = fixtureSnapshot()
        other.host?.id = "linux"
        await outbox.flush(snapshot: other, send: { _ in
            XCTFail("Wrong host")
            throw URLError(.cancelled)
        }, received: { _ in })
        XCTAssertEqual(outbox.entries.count, 1)
        XCTAssertEqual(outbox.entries.first?.attempts, 0)
    }

    func testStorageFailureDoesNotAcceptSendAndCorruptionIsNotOverwritten() {
        var writes = 0
        let failed = NativeCommandOutbox(storage: .init(read: { [] }, write: { _ in throw CocoaError(.fileWriteOutOfSpace) }))
        XCTAssertFalse(failed.enqueue(fixtureCommand(key: "one"), hostID: "mac"))
        XCTAssertTrue(failed.entries.isEmpty)
        XCTAssertNotNil(failed.storageIssue)
        let corrupt = NativeCommandOutbox(storage: .init(read: { throw CocoaError(.fileReadCorruptFile) }, write: { _ in writes += 1 }))
        XCTAssertFalse(corrupt.enqueue(fixtureCommand(key: "two"), hostID: "mac"))
        XCTAssertEqual(writes, 0)
    }

    func testQueuedWithdrawalAndExplicitFailurePreserveText() async {
        let box = MemoryOutbox()
        let outbox = NativeCommandOutbox(storage: box.storage)
        XCTAssertTrue(outbox.enqueue(fixtureCommand(key: "withdraw"), hostID: "mac"))
        XCTAssertTrue(outbox.withdraw(outbox.entries[0].id))
        XCTAssertTrue(outbox.entries.isEmpty)
        XCTAssertTrue(outbox.enqueue(fixtureCommand(key: "reject"), hostID: "mac"))
        await outbox.flush(snapshot: fixtureSnapshot(), send: { _ in
            throw BridgeAPIError(code: "invalid_command", message: "Invalid workspace", recoverable: false)
        }, received: { _ in })
        XCTAssertEqual(outbox.entries.first?.state, .failed)
        XCTAssertEqual(outbox.entries.first?.preview, "test task")
    }

    func testTextAndRegisteredAttachmentsRestoreTogether() throws {
        let suite = "zimlo.draft-test.\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let material = try JSONDecoder().decode(Material.self, from: Data(#"{"id":"material-a","hostId":"mac","kind":"document","mimeType":"text/plain","name":"notes.txt","sizeBytes":8,"sha256":"digest","origin":"attachment","status":"ready","createdAt":"","updatedAt":""}"#.utf8))
        let draft = NativeComposerDraft(hostID: "mac", text: "Continue with the attachment", workspaceID: "workspace", provider: .claude, materials: [material])
        draft.save(key: "draft", defaults: defaults)
        XCTAssertEqual(NativeComposerDraft.load(key: "draft", defaults: defaults), draft)
        NativeComposerDraft.clear(key: "draft", defaults: defaults)
        XCTAssertNil(NativeComposerDraft.load(key: "draft", defaults: defaults))
    }

    func testNegativeCommandReceiptCannotEraseTheOutbox() async throws {
        let box = MemoryOutbox()
        let outbox = NativeCommandOutbox(storage: box.storage)
        XCTAssertTrue(outbox.enqueue(fixtureCommand(key: "negative-receipt"), hostID: "mac"))
        let message = try JSONDecoder().decode(ServerEnvelope.self, from: Data(#"{"type":"task.command.result","ok":false,"message":"Project is unavailable"}"#.utf8))
        await outbox.flush(snapshot: fixtureSnapshot(), send: { _ in
            LocalCommandResponse(ok: true, messages: [message], snapshot: fixtureSnapshot())
        }, received: { _ in })
        XCTAssertEqual(outbox.entries.first?.state, .failed)
        XCTAssertEqual(outbox.entries.first?.error, "Project is unavailable")
        XCTAssertEqual(box.entries.first?.preview, "test task")
    }
}

@MainActor
private final class MemoryOutbox {
    var entries: [NativeOutboxEntry] = []
    var storage: NativeOutboxStorage {
        .init(read: { self.entries }, write: { self.entries = $0 })
    }
}

private func fixtureSnapshot() -> NativeSnapshot {
    var snapshot = NativeSnapshot.empty
    snapshot.host = ZimloHost(id: "mac", name: "Mac", platform: "macos", lastSeenAt: "")
    return snapshot
}

private func fixtureCommand(key: String) -> ClientCommand {
    ClientCommand(type: "task.create", ["idempotencyKey": .string(key), "workspaceId": .string("workspace"),
                                       "provider": .string("codex"), "text": .string("test task"), "materialIds": .array([])])
}

private func fixtureAction(_ id: String) -> PendingAction {
    PendingAction(actionId: id, hostId: "mac", sessionId: "session", upstreamRequestId: nil, kind: "approval",
                  title: id, detail: "Check the task", availableDecisions: [], expiresAt: "2099-09-05T00:00:00Z",
                  state: "pending", createdAt: "2026-09-05T00:00:00Z", resolvedAt: nil, approvalContext: nil)
}

private func fixturePost(_ id: String, kind: String = "result", at: String = "2026-09-05T00:00:00Z") -> FeedPost {
    FeedPost(id: id, hostId: "mac", projectId: nil, taskId: "task", runId: "run", agentId: "codex", sessionId: "session",
             kind: kind, presentation: CardPresentation(system: "editorial", theme: "ink_classic", layout: "feature",
                                                        typography: "sans", density: "balanced", mediaPlacement: "inline"),
             headline: id, takeaway: "Result", highlights: [], blocks: [], proof: nil, content: nil, dedupeKey: id,
             source: "agent", createdAt: at)
}
