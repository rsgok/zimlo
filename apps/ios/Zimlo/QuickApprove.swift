import Foundation

// 锁屏快捷审批的纯逻辑层：解析密封路由明文、映射 decisionId、生成确定性幂等键。
// APNs `aps.category` 是明文通用标识（不含任务内容）；决策细节只在加密路由内。
// 不 import UIKit，保持可被 macOS SDK 的 swiftc harness 直接编译测试。
enum QuickApprove {
    static let category = "ZIMLO_LOW_RISK_APPROVAL"
    static let allowOnceIdentifier = "ZIMLO_APPROVE_ONCE"
    static let denyIdentifier = "ZIMLO_DENY"

    struct Payload: Decodable, Sendable {
        let version: Int?
        let sessionId: String
        let actionId: String?
        let decision: String?
        let denyDecision: String?
        let expiresAt: String?
    }

    struct Route: Equatable, Sendable {
        let sessionId: String
        let actionId: String
        let allowOnceId: String
        let denyId: String
        let expiresAt: Date
    }

    enum Decision: Sendable {
        case allowOnce
        case deny

        init?(actionIdentifier: String) {
            switch actionIdentifier {
            case QuickApprove.allowOnceIdentifier: self = .allowOnce
            case QuickApprove.denyIdentifier: self = .deny
            default: return nil
            }
        }
    }

    // 从解密后的推送路由 JSON 解析快捷审批路由。非 v1 或关键字段缺失时返回 nil，
    // 调用方回退为普通打开路由（旧推送格式与旧客户端兼容）。
    static func route(from payload: [String: Any]) -> Route? {
        guard let sessionId = payload["sessionId"] as? String else { return nil }
        return route(from: Payload(
            version: payload["version"] as? Int,
            sessionId: sessionId,
            actionId: payload["actionId"] as? String,
            decision: payload["decision"] as? String,
            denyDecision: payload["denyDecision"] as? String,
            expiresAt: payload["expiresAt"] as? String
        ))
    }

    static func route(from payload: Payload) -> Route? {
        guard payload.version == 1,
              let actionId = payload.actionId,
              let allowOnceId = payload.decision,
              let denyId = payload.denyDecision,
              let expiresAtText = payload.expiresAt,
              let expiresAt = parseISO8601(expiresAtText) else { return nil }
        return Route(sessionId: payload.sessionId, actionId: actionId,
                     allowOnceId: allowOnceId, denyId: denyId, expiresAt: expiresAt)
    }

    static func decisionId(for decision: Decision, in route: Route) -> String {
        switch decision {
        case .allowOnce: return route.allowOnceId
        case .deny: return route.denyId
        }
    }

    // 确定性幂等键：连点/通知重复投递产生同键，服务端按设备+键去重，
    // 保证锁屏快捷操作始终只有一次服务端执行。
    static func idempotencyKey(actionId: String, decisionId: String) -> String {
        "quick:\(actionId):\(decisionId)"
    }

    // 本地先做过期判定：已过期不发送决策，只引导用户进 App 查看最新状态。
    static func isExpired(_ route: Route, now: Date = Date()) -> Bool {
        route.expiresAt <= now
    }

    // ISO8601 兼容带/不带毫秒（与 PairingPayload 的 expiresAt 处理一致）。
    private static func parseISO8601(_ text: String) -> Date? {
        if let parsed = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(text) {
            return parsed
        }
        return try? Date.ISO8601FormatStyle().parse(text)
    }
}
