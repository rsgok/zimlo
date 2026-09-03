import Foundation
import Security

struct DeviceCredentials: Codable, Hashable {
    var host: ZimloHost
    var bridgeURL: URL
    var deviceId: String
    var deviceKey: String
    var remoteRelayURL: URL?
    var remoteAccessToken: String?

    private enum CodingKeys: String, CodingKey {
        case host, bridgeURL, deviceId, deviceKey, remoteRelayURL, remoteAccessToken
    }

    init(host: ZimloHost, bridgeURL: URL, deviceId: String, deviceKey: String, remoteRelayURL: URL?, remoteAccessToken: String?) {
        self.host = host
        self.bridgeURL = bridgeURL
        self.deviceId = deviceId
        self.deviceKey = deviceKey
        self.remoteRelayURL = remoteRelayURL
        self.remoteAccessToken = remoteAccessToken
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        bridgeURL = try container.decode(URL.self, forKey: .bridgeURL)
        deviceId = try container.decode(String.self, forKey: .deviceId)
        deviceKey = try container.decode(String.self, forKey: .deviceKey)
        remoteRelayURL = try container.decodeIfPresent(URL.self, forKey: .remoteRelayURL)
        remoteAccessToken = try container.decodeIfPresent(String.self, forKey: .remoteAccessToken)
        host = try container.decodeIfPresent(ZimloHost.self, forKey: .host) ?? ZimloHost(
            id: "legacy_\(deviceId)",
            name: bridgeURL.host ?? "Zimlo Host",
            platform: "macos",
            lastSeenAt: ""
        )
    }
}

enum KeychainStore {
    private static let service = "com.zimlo.ios.bridge"
    private static let account = "device-credentials"
    private static var pushAccessGroup: String? {
        Bundle.main.object(forInfoDictionaryKey: "ZimloKeychainAccessGroup") as? String
    }

    static func load() -> DeviceCredentials? {
        loadAll().first
    }

    static func loadAll() -> [DeviceCredentials] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return [] }
        if let values = try? JSONDecoder().decode([DeviceCredentials].self, from: data) { return values }
        if let legacy = try? JSONDecoder().decode(DeviceCredentials.self, from: data) { return [legacy] }
        return []
    }

    static func save(_ credentials: DeviceCredentials) throws {
        var values = loadAll()
        values.removeAll { $0.host.id == credentials.host.id }
        values.insert(credentials, at: 0)
        try saveAll(values)
    }

    static func remove(hostId: String) throws {
        try saveAll(loadAll().filter { $0.host.id != hostId })
    }

    private static func saveAll(_ values: [DeviceCredentials]) throws {
        let data = try JSONEncoder().encode(values)
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(base as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var insert = base
            attributes.forEach { insert[$0.key] = $0.value }
            let insertStatus = SecItemAdd(insert as CFDictionary, nil)
            guard insertStatus == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(insertStatus)) }
        } else if status != errSecSuccess {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
    }

    static func clear() {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ] as CFDictionary)
    }

    static func loadPushPrivateKey() -> Data? {
        loadData(account: "push-route-private-key")
    }

    static func savePushPrivateKey(_ data: Data) throws {
        try saveData(data, account: "push-route-private-key")
    }

    static func clearPushPrivateKey() {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "push-route-private-key",
        ]
        if let pushAccessGroup { query[kSecAttrAccessGroup as String] = pushAccessGroup }
        SecItemDelete(query as CFDictionary)
    }

    private static func loadData(account: String) -> Data? {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        if let pushAccessGroup { query[kSecAttrAccessGroup as String] = pushAccessGroup }
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else { return nil }
        return item as? Data
    }

    private static func saveData(_ data: Data, account: String) throws {
        var base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let pushAccessGroup { base[kSecAttrAccessGroup as String] = pushAccessGroup }
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(base as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var insert = base
            attributes.forEach { insert[$0.key] = $0.value }
            let insertStatus = SecItemAdd(insert as CFDictionary, nil)
            guard insertStatus == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(insertStatus)) }
        } else if status != errSecSuccess {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
    }
}
