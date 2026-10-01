import Foundation

struct NativeComposerDraft: Codable, Equatable {
    var hostID: String?
    var text: String
    var workspaceID: String
    var provider: Provider
    var materials: [Material]
    var unresolvedMaterialIDs: [String]? = nil

    static func load(key: String, defaults: UserDefaults = .standard) -> Self? {
        guard let data = defaults.data(forKey: key + ".v2") else { return nil }
        return try? JSONDecoder().decode(Self.self, from: data)
    }

    func save(key: String, defaults: UserDefaults = .standard) {
        guard let data = try? JSONEncoder().encode(self) else { return }
        defaults.set(data, forKey: key + ".v2")
    }

    static func clear(key: String, defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: key)
        defaults.removeObject(forKey: key + ".v2")
    }
}
