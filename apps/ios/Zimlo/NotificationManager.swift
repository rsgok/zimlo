import CryptoKit
import Foundation
import UIKit
import UserNotifications

@MainActor
final class NotificationManager: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationManager()

    var onRegistration: ((String, String) -> Void)?
    var onRoute: ((String) -> Void)?
    var onError: ((String) -> Void)?
    // 锁屏快捷审批：actionId, sessionId, decisionId, idempotencyKey（服务端仍重校验）。
    var onQuickDecide: ((String, String, String, String) -> Void)?
    // 快捷审批已过期：只携带 sessionId，引导进 App 查看最新状态。
    var onQuickExpired: ((String) -> Void)?

    private var cachedRoutePrivateKey: Curve25519.KeyAgreement.PrivateKey?
    private var routePrivateKey: Curve25519.KeyAgreement.PrivateKey {
        if let cachedRoutePrivateKey { return cachedRoutePrivateKey }
        if let stored = KeychainStore.loadPushPrivateKey(),
           let key = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: stored) {
            cachedRoutePrivateKey = key
            return key
        }
        let key = Curve25519.KeyAgreement.PrivateKey()
        try? KeychainStore.savePushPrivateKey(key.rawRepresentation)
        cachedRoutePrivateKey = key
        return key
    }

    /// A new pairing must not reuse a push-route identity from the removed
    /// device. The next APNs registration lazily creates and persists a new key.
    func resetRouteKey() {
        cachedRoutePrivateKey = nil
        KeychainStore.clearPushPrivateKey()
    }

    func configure() {
        UNUserNotificationCenter.current().delegate = self
        // 低风险审批的锁屏快捷操作；高风险与需输入的审批仍只能打开 App。
        let allowOnce = UNNotificationAction(identifier: QuickApprove.allowOnceIdentifier, title: "批准一次")
        let deny = UNNotificationAction(identifier: QuickApprove.denyIdentifier, title: "拒绝", options: [.destructive])
        UNUserNotificationCenter.current().setNotificationCategories([
            UNNotificationCategory(identifier: QuickApprove.category, actions: [allowOnce, deny], intentIdentifiers: []),
        ])
        Task { _ = await refreshRegistration() }
    }

    func requestAuthorization() async -> Bool {
        do {
            let allowed = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
            if allowed { UIApplication.shared.registerForRemoteNotifications() }
            return allowed
        } catch {
            onError?("通知权限请求失败：\(error.localizedDescription)")
            return false
        }
    }

    func authorizationStatus() async -> UNAuthorizationStatus {
        await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    @discardableResult
    func refreshRegistration() async -> UNAuthorizationStatus {
        let status = await authorizationStatus()
        if [.authorized, .provisional, .ephemeral].contains(status) {
            UIApplication.shared.registerForRemoteNotifications()
        }
        return status
    }

    func didRegister(deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        let publicKey = ZimloCrypto.base64URL(routePrivateKey.publicKey.rawRepresentation)
        onRegistration?(token, publicKey)
    }

    func didFailRegistration(_ error: Error) {
        onError?("APNs 注册失败：\(error.localizedDescription)")
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let info = response.notification.request.content.userInfo
        guard let route = info["route"] as? [String: String],
              let payload = try? await MainActor.run(body: { try self.decryptRoutePayload(route) }) else { return }
        // 锁屏快捷操作：只有 v1 路由且双 decisionId 齐全才走快捷审批，否则回退普通打开。
        if let quickDecision = QuickApprove.Decision(actionIdentifier: response.actionIdentifier),
           let quickRoute = QuickApprove.route(from: payload) {
            if QuickApprove.isExpired(quickRoute) {
                await MainActor.run { self.onQuickExpired?(quickRoute.sessionId) }
            } else {
                let decisionId = QuickApprove.decisionId(for: quickDecision, in: quickRoute)
                let key = QuickApprove.idempotencyKey(actionId: quickRoute.actionId, decisionId: decisionId)
                await MainActor.run { self.onQuickDecide?(quickRoute.actionId, quickRoute.sessionId, decisionId, key) }
            }
            return
        }
        await MainActor.run { self.onRoute?(payload.sessionId) }
    }

    private func decryptRoutePayload(_ route: [String: String]) throws -> QuickApprove.Payload {
        guard let publicKeyText = route["ephemeralPublicKey"],
              let nonceText = route["nonce"],
              let ciphertextText = route["ciphertext"],
              let publicKeyData = ZimloCrypto.fromBase64URL(publicKeyText),
              let nonceData = ZimloCrypto.fromBase64URL(nonceText),
              let ciphertext = ZimloCrypto.fromBase64URL(ciphertextText) else {
            throw ZimloCryptoError.invalidCiphertext
        }
        let peer = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: publicKeyData)
        let shared = try routePrivateKey.sharedSecretFromKeyAgreement(with: peer)
        let key = shared.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: Data(),
            sharedInfo: Data("zimlo-push-route-v1".utf8),
            outputByteCount: 32
        )
        guard ciphertext.count >= 16 else { throw ZimloCryptoError.invalidCiphertext }
        let split = ciphertext.count - 16
        let sealed = try ChaChaPoly.SealedBox(
            nonce: ChaChaPoly.Nonce(data: nonceData),
            ciphertext: ciphertext.prefix(split),
            tag: ciphertext.suffix(16)
        )
        let data = try ChaChaPoly.open(sealed, using: key, authenticating: Data("zimlo-push-route-v1".utf8))
        return try JSONDecoder().decode(QuickApprove.Payload.self, from: data)
    }
}

@MainActor
final class ZimloAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        NotificationManager.shared.configure()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationManager.shared.didRegister(deviceToken: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationManager.shared.didFailRegistration(error)
    }
}
