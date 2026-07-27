import Foundation

@MainActor
final class OnboardingStore: ObservableObject {
    @Published var step: Int {
        didSet { UserDefaults.standard.set(step, forKey: Self.stepKey) }
    }
    @Published var completed: Bool {
        didSet { UserDefaults.standard.set(completed, forKey: Self.completedKey) }
    }

    private static let stepKey = "zimlo.onboarding.step.v1"
    private static let completedKey = "zimlo.onboarding.completed.v1"

    init() {
        step = min(max(UserDefaults.standard.integer(forKey: Self.stepKey), 0), 3)
        completed = UserDefaults.standard.bool(forKey: Self.completedKey)
    }

    func finish() {
        completed = true
        step = 3
    }

    func restart() {
        completed = false
        step = 0
    }
}
