import XCTest
@testable import ZimloMac

final class ExplicitRetryProcessPolicyTests: XCTestCase {
    func testReplacesOnlyRunningOwnedProcessWhenProbeIsUnreachable() {
        XCTAssertTrue(ExplicitRetryProcessPolicy.shouldReplaceOwnedProcess(
            hasRunningOwnedProcess: true,
            probeIsUnreachable: true
        ))
        XCTAssertFalse(ExplicitRetryProcessPolicy.shouldReplaceOwnedProcess(
            hasRunningOwnedProcess: false,
            probeIsUnreachable: true
        ), "An external or unowned process must never be terminated")
        XCTAssertFalse(ExplicitRetryProcessPolicy.shouldReplaceOwnedProcess(
            hasRunningOwnedProcess: true,
            probeIsUnreachable: false
        ), "A responsive Bridge must be preserved")
        XCTAssertFalse(ExplicitRetryProcessPolicy.shouldReplaceOwnedProcess(
            hasRunningOwnedProcess: false,
            probeIsUnreachable: false
        ))
    }

    func testTerminationTimeoutRetainsOwnershipAndBlocksDuplicateLaunch() {
        let processStillRunningAfterTimeout = true

        XCTAssertTrue(OwnedProcessLifecyclePolicy.shouldRetainReference(
            processIsStillRunning: processStillRunningAfterTimeout
        ))
        XCTAssertFalse(OwnedProcessLifecyclePolicy.canLaunchReplacement(
            hasRunningOwnedProcess: processStillRunningAfterTimeout
        ), "A second retry must not launch another Bridge while the retained owned process is alive")
    }

    func testConfirmedExitAllowsReplacementLaunch() {
        XCTAssertFalse(OwnedProcessLifecyclePolicy.shouldRetainReference(
            processIsStillRunning: false
        ))
        XCTAssertTrue(OwnedProcessLifecyclePolicy.canLaunchReplacement(
            hasRunningOwnedProcess: false
        ))
    }

    func testCompatibleReuseClearsSuppressionSoLaterExitIsObserved() {
        XCTAssertTrue(OwnedProcessLifecyclePolicy.shouldClearSuppressionForCompatibleReuse(
            suppressionMatchesRetainedProcess: true
        ))
        XCTAssertFalse(OwnedProcessLifecyclePolicy.shouldClearSuppressionForCompatibleReuse(
            suppressionMatchesRetainedProcess: false
        ), "A compatible external Bridge must not change unrelated process supervision")
    }
}

final class RecoveryHaltPolicyTests: XCTestCase {
    func testIncidentalHealthyRefreshCannotBypassHalt() {
        XCTAssertFalse(RecoveryHaltPolicy.allowsAutomaticStateTransition(
            recoveryHalted: true,
            stopping: false
        ))
    }

    func testExplicitRetryReleaseAllowsReadyTransitionAndMonitoringStart() {
        // retry() is the sole owner of the true -> false transition before it
        // calls start(); a successful start then owns beginMonitoring().
        let recoveryHaltedAfterExplicitRetry = false
        XCTAssertTrue(RecoveryHaltPolicy.allowsAutomaticStateTransition(
            recoveryHalted: recoveryHaltedAfterExplicitRetry,
            stopping: false
        ))
    }

    func testConcurrentStopLateRefreshCannotPromoteReady() {
        XCTAssertFalse(RecoveryHaltPolicy.allowsAutomaticStateTransition(
            recoveryHalted: false,
            stopping: true
        ), "A late status response cannot replace the stopping state or return ready")
    }

    func testStartupWaitAndMonitorHonorDurableManualStop() {
        XCTAssertEqual(
            ManualStopTransitionPolicy.decide(manualStopSet: true),
            .enterManualStoppedAndHaltMonitoring
        )
        XCTAssertEqual(
            ManualStopTransitionPolicy.decide(manualStopSet: false),
            .continueLifecycle
        )
    }

    func testHaltedLateExitPreservesTerminalState() {
        XCTAssertFalse(UnexpectedExitRecoveryPolicy.shouldRecover(
            stopping: false,
            recoveryHalted: true,
            terminationStatus: 1
        ), "A late owned-process exit must not replace the terminal state with a retry promise")
    }

    func testUnexpectedNonzeroExitRecoversOnlyWhileActivelyManaged() {
        XCTAssertTrue(UnexpectedExitRecoveryPolicy.shouldRecover(
            stopping: false,
            recoveryHalted: false,
            terminationStatus: 1
        ))
        XCTAssertFalse(UnexpectedExitRecoveryPolicy.shouldRecover(
            stopping: true,
            recoveryHalted: false,
            terminationStatus: 1
        ))
        XCTAssertFalse(UnexpectedExitRecoveryPolicy.shouldRecover(
            stopping: false,
            recoveryHalted: false,
            terminationStatus: 0
        ))
    }
}

final class RestartPolicyTests: XCTestCase {
    private let base = Date(timeIntervalSince1970: 1_000_000)

    func testBackoffClimbsAndCapsAtThirtySeconds() {
        var policy = RestartPolicy()
        // 每次失败间隔 121 秒（超出熔断窗口），熔断不触发，退避逐档爬升并封顶 30 秒
        let expected: [TimeInterval] = [1, 2, 4, 8, 16, 30, 30]
        for (index, delay) in expected.enumerated() {
            let decision = policy.recordFailure(at: base.addingTimeInterval(TimeInterval(index * 121)))
            XCTAssertEqual(decision, .retry(after: delay), "第 \(index + 1) 次失败的退避档位不对")
        }
    }

    func testDenseFailuresTripCircuitAtFifthFailure() {
        var policy = RestartPolicy()
        XCTAssertEqual(policy.recordFailure(at: base), .retry(after: 1))
        XCTAssertEqual(policy.recordFailure(at: base.addingTimeInterval(1)), .retry(after: 2))
        XCTAssertEqual(policy.recordFailure(at: base.addingTimeInterval(2)), .retry(after: 4))
        XCTAssertEqual(policy.recordFailure(at: base.addingTimeInterval(4)), .retry(after: 8))
        XCTAssertEqual(policy.recordFailure(at: base.addingTimeInterval(8)), .circuitOpen)
    }

    func testFailuresOutsideWindowDoNotCountTowardCircuit() {
        var policy = RestartPolicy()
        // 窗口外的旧失败被剔除：窗口内只有 4 次，不熔断
        XCTAssertEqual(policy.recordFailure(at: base), .retry(after: 1))
        XCTAssertEqual(policy.recordFailure(at: base.addingTimeInterval(1)), .retry(after: 2))
        let later = base.addingTimeInterval(300)
        XCTAssertEqual(policy.recordFailure(at: later), .retry(after: 4))
        XCTAssertEqual(policy.recordFailure(at: later.addingTimeInterval(1)), .retry(after: 8))
        XCTAssertEqual(policy.recordFailure(at: later.addingTimeInterval(2)), .retry(after: 16))
        XCTAssertEqual(policy.recordFailure(at: later.addingTimeInterval(3)), .retry(after: 30))
    }

    func testResetRestartsBackoffFromScratch() {
        var policy = RestartPolicy()
        _ = policy.recordFailure(at: base)
        _ = policy.recordFailure(at: base.addingTimeInterval(1))
        policy.reset()
        XCTAssertEqual(policy.recordFailure(at: base.addingTimeInterval(2)), .retry(after: 1))
    }
}

final class RecoveryStabilityTests: XCTestCase {
    private let base = Date(timeIntervalSince1970: 2_000_000)

    func testShortHealthyBurstsDoNotResetFailureHistory() {
        var stability = RecoveryStability()
        XCTAssertFalse(stability.observeHealthy(at: base))
        XCTAssertFalse(stability.observeHealthy(at: base.addingTimeInterval(30)))
        stability.observeFailure()
        XCTAssertFalse(stability.observeHealthy(at: base.addingTimeInterval(31)))
        XCTAssertFalse(stability.observeHealthy(at: base.addingTimeInterval(120)))
    }

    func testStableWindowAllowsRecoveryReset() {
        var stability = RecoveryStability()
        XCTAssertFalse(stability.observeHealthy(at: base))
        XCTAssertFalse(stability.observeHealthy(at: base.addingTimeInterval(119.9)))
        XCTAssertTrue(stability.observeHealthy(at: base.addingTimeInterval(120)))
    }
}

final class BridgeErrorDecoderTests: XCTestCase {
    private let fallback = "接入失败，请稍后重试。"

    private func decode(_ json: String) -> OperationIssue {
        BridgeErrorDecoder.decode(Data(json.utf8), fallback: fallback)
    }

    func testPrefersStableStructureWithAction() {
        let issue = decode("""
        {"code":"no_integrations","message":"尚未发现 Codex 或 Claude Code。","recoverable":true,"action":"请先安装其中一个 Agent。"}
        """)
        XCTAssertEqual(issue.message, "尚未发现 Codex 或 Claude Code。")
        XCTAssertEqual(issue.action, "请先安装其中一个 Agent。")
    }

    func testStableStructureWithoutAction() {
        let issue = decode("""
        {"code":"pairing_unavailable","message":"暂时无法创建配对二维码。","recoverable":true}
        """)
        XCTAssertEqual(issue.message, "暂时无法创建配对二维码。")
        XCTAssertNil(issue.action)
    }

    func testLegacyFastifyErrorPrefersMessageOverHttpStatusName() {
        let issue = decode("""
        {"statusCode":500,"error":"Internal Server Error","message":"尚未发现 Codex 或 Claude Code。"}
        """)
        XCTAssertEqual(issue.message, "尚未发现 Codex 或 Claude Code。")
        XCTAssertNil(issue.action)
    }

    func testLegacyErrorFieldUsedWhenMessageMissing() {
        let issue = decode(#"{"error":"端口必须是 1-65535 的整数。"}"#)
        XCTAssertEqual(issue.message, "端口必须是 1-65535 的整数。")
    }

    func testHttpStatusNameAloneFallsBack() {
        let issue = decode(#"{"error":"Internal Server Error"}"#)
        XCTAssertEqual(issue.message, fallback)
        XCTAssertEqual(issue.action, "检查网络和后台服务后重试。")
    }

    func testEmptyStableMessageFallsBack() {
        let issue = decode(#"{"code":"x","message":"","recoverable":false}"#)
        XCTAssertEqual(issue.message, fallback)
    }

    func testNonJsonFallsBack() {
        let issue = BridgeErrorDecoder.decode(Data("not json".utf8), fallback: fallback)
        XCTAssertEqual(issue.message, fallback)
        XCTAssertEqual(issue.action, "检查网络和后台服务后重试。")
    }

    func testTechnicalFetchFailureFallsBackToProductCopy() {
        let issue = decode(#"{"code":"cloud_unavailable","message":"fetch failed","recoverable":true}"#)
        XCTAssertEqual(issue.message, fallback)
        XCTAssertEqual(issue.action, "检查网络和后台服务后重试。")
    }
}

final class OperationIssueMapperTests: XCTestCase {
    func testTimeoutBecomesLocalizedActionableMessage() {
        let issue = OperationIssueMapper.issue(
            for: URLError(.timedOut),
            fallback: "fallback",
            retryAction: "请重试。"
        )

        XCTAssertEqual(issue.message, "操作超时。")
        XCTAssertEqual(issue.action, "请重试。")
    }

    func testConnectionFailureDoesNotExposeFoundationErrorText() {
        let issue = OperationIssueMapper.issue(
            for: URLError(.cannotConnectToHost),
            fallback: "fallback",
            retryAction: "确认服务后重试。"
        )

        XCTAssertEqual(issue.message, "暂时无法连接后台服务。")
        XCTAssertEqual(issue.action, "确认服务后重试。")
    }
}

final class StartupLogInspectorTests: XCTestCase {
    func testAddressInUseIsTerminal() {
        let log = "Error: listen EADDRINUSE: address already in use 127.0.0.1:4747\n    at Server.setupListenHandle"
        XCTAssertEqual(StartupLogInspector.classify(log), .portInUse)
    }

    func testMissingModuleIsTerminal() {
        XCTAssertEqual(
            StartupLogInspector.classify("Error: Cannot find module '/runtime/cli/dist/index.js'"),
            .fatal(reason: "内置运行时文件缺失或损坏，请重新安装 Zimlo。")
        )
        XCTAssertEqual(
            StartupLogInspector.classify("code: 'ERR_MODULE_NOT_FOUND'"),
            .fatal(reason: "内置运行时文件缺失或损坏，请重新安装 Zimlo。")
        )
    }

    func testCorruptConfigIsTerminal() {
        XCTAssertEqual(
            StartupLogInspector.classify("SyntaxError: Unexpected token } in JSON at position 12"),
            .fatal(reason: "本地配置或数据文件损坏，请打开日志定位后修复。")
        )
    }

    func testUnknownCrashIsTransient() {
        XCTAssertEqual(StartupLogInspector.classify("Error: boom\n    at main"), .transient)
        XCTAssertEqual(StartupLogInspector.classify(""), .transient)
    }
}

final class PortOwnerLookupTests: XCTestCase {
    func testParsesFirstProcessWithPidAndCommand() {
        let output = "p1234\ncnode\np5678\ncCode Helper\n"
        let owner = PortOwnerLookup.parse(output)
        XCTAssertEqual(owner?.pid, "1234")
        XCTAssertEqual(owner?.command, "node")
    }

    func testEmptyOrIncompleteOutputReturnsNil() {
        XCTAssertNil(PortOwnerLookup.parse(""))
        XCTAssertNil(PortOwnerLookup.parse("p1234\n"))
    }
}

final class PairingCountdownTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 2_000_000)

    func testRemainingSecondsRoundsUpAndFloorsAtZero() {
        XCTAssertEqual(PairingCountdown.remainingSeconds(expiresAt: now.addingTimeInterval(90), now: now), 90)
        XCTAssertEqual(PairingCountdown.remainingSeconds(expiresAt: now.addingTimeInterval(89.2), now: now), 90)
        XCTAssertEqual(PairingCountdown.remainingSeconds(expiresAt: now.addingTimeInterval(-5), now: now), 0)
    }

    func testExpiryBoundary() {
        XCTAssertFalse(PairingCountdown.isExpired(expiresAt: now.addingTimeInterval(0.5), now: now))
        XCTAssertTrue(PairingCountdown.isExpired(expiresAt: now, now: now))
        XCTAssertTrue(PairingCountdown.isExpired(expiresAt: now.addingTimeInterval(-1), now: now))
    }
}

final class AppVersionTests: XCTestCase {
    func testCombinesShortVersionAndBuild() {
        XCTAssertEqual(AppVersion.display(shortVersion: "0.3.0", build: "42"), "0.3.0 (42)")
    }

    func testOmitsMissingOrEmptyBuild() {
        XCTAssertEqual(AppVersion.display(shortVersion: "0.3.0", build: nil), "0.3.0")
        XCTAssertEqual(AppVersion.display(shortVersion: "0.3.0", build: ""), "0.3.0")
    }

    func testMissingVersionReadsAsDev() {
        XCTAssertEqual(AppVersion.display(shortVersion: nil, build: "42"), "dev")
        XCTAssertEqual(AppVersion.display(shortVersion: "", build: "42"), "dev")
    }
}
