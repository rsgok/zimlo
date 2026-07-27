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

    private lazy var routePrivateKey: Curve25519.KeyAgreement.PrivateKey = {
        if let stored = KeychainStore.loadPushPrivateKey(),
           let key = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: stored) {
            return key
        }
        let key = Curve25519.KeyAgreement.PrivateKey()
        try? KeychainStore.savePushPrivateKey(key.rawRepresentation)
        return key
    }()

    func configure() {
        UNUserNotificationCenter.current().delegate = self
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
              let sessionId = try? await MainActor.run(body: { try self.decryptRoute(route) }) else { return }
        await MainActor.run { self.onRoute?(sessionId) }
    }

    private func decryptRoute(_ route: [String: String]) throws -> String {
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
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard let sessionId = object?["sessionId"] as? String else { throw ZimloCryptoError.invalidCiphertext }
        return sessionId
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
