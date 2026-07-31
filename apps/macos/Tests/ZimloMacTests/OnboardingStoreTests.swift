import XCTest
@testable import ZimloMac

@MainActor
final class OnboardingStoreTests: XCTestCase {
    func testStepIsClampedToKnownFlow() {
        UserDefaults.standard.set(99, forKey: "zimlo.onboarding.step.v1")
        let store = OnboardingStore()
        XCTAssertEqual(store.step, 3)
    }

    func testCompletionRequiresTruthfulReadyState() {
        XCTAssertTrue(OnboardingCompletionGate.canFinish(.ready))
        XCTAssertFalse(OnboardingCompletionGate.canFinish(.starting))
        XCTAssertFalse(OnboardingCompletionGate.canFinish(.stopping))
        XCTAssertFalse(OnboardingCompletionGate.canFinish(.degraded("recovering")))
        XCTAssertFalse(OnboardingCompletionGate.canFinish(.manualStopped))
        XCTAssertFalse(OnboardingCompletionGate.canFinish(.unavailable("failed")))
    }
}
