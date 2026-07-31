import UIKit

// 全 App 统一的触觉反馈入口。规则：本地持久化成功 = 轻触；服务端确认审批成功 =
// 成功通知（服务端确认前绝不播成功）；打开高风险审批 = 警告；移除/归档 = 中等。
@MainActor
enum Haptics {
    private static let selectionGenerator = UISelectionFeedbackGenerator()

    static func selection() {
        selectionGenerator.selectionChanged()
        selectionGenerator.prepare()
    }

    static func persisted() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    static func serverConfirmed() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    static func highRiskPrompt() {
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }

    static func destructiveLocalAction() {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    }
}
