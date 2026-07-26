import CryptoKit
import Security
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttemptContent: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        bestAttemptContent = content
        if let route = request.content.userInfo["route"] as? [String: String],
           let title = try? decryptTaskTitle(route),
           !title.isEmpty {
            content.body = title
        }
        contentHandler(content)
    }

    override func serviceExtensionTimeWillExpire() {
        if let contentHandler, let bestAttemptContent { contentHandler(bestAttemptContent) }
    }

    private func decryptTaskTitle(_ route: [String: String]) throws -> String {
        guard let privateKeyData = loadPrivateKey(),
              let publicKeyData = decode(route["ephemeralPublicKey"]),
              let nonceData = decode(route["nonce"]),
              let ciphertext = decode(route["ciphertext"]) else {
            throw NSError(domain: "ZimloNotificationService", code: 1)
        }
        let privateKey = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: privateKeyData)
        let peer = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: publicKeyData)
        let shared = try privateKey.sharedSecretFromKeyAgreement(with: peer)
        let info = Data("zimlo-push-route-v1".utf8)
        let key = shared.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: Data(),
            sharedInfo: info,
            outputByteCount: 32
        )
        guard ciphertext.count >= 16 else { throw NSError(domain: "ZimloNotificationService", code: 2) }
        let split = ciphertext.count - 16
        let box = try ChaChaPoly.SealedBox(
            nonce: ChaChaPoly.Nonce(data: nonceData),
            ciphertext: ciphertext.prefix(split),
            tag: ciphertext.suffix(16)
        )
        let plaintext = try ChaChaPoly.open(box, using: key, authenticating: info)
        let object = try JSONSerialization.jsonObject(with: plaintext) as? [String: Any]
        return object?["taskTitle"] as? String ?? ""
    }

    private func loadPrivateKey() -> Data? {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.zimlo.ios.bridge",
            kSecAttrAccount as String: "push-route-private-key",
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        if let group = Bundle.main.object(forInfoDictionaryKey: "ZimloKeychainAccessGroup") as? String {
            query[kSecAttrAccessGroup as String] = group
        }
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else { return nil }
        return item as? Data
    }

    private func decode(_ value: String?) -> Data? {
        guard let value else { return nil }
        let normalized = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        return Data(base64Encoded: normalized.padding(toLength: ((normalized.count + 3) / 4) * 4, withPad: "=", startingAt: 0))
    }
}
