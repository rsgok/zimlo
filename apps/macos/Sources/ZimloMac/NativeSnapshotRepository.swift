import Foundation

actor NativeSnapshotRepository {
    private var cached: NativeSnapshot?
    private var etag: String?
    private var identity: String?

    func fetch(baseURL: URL, session: URLSession) async throws -> NativeSnapshot {
        let descriptor = try LocalServiceIdentity.load()
        let currentIdentity = "\(descriptor.hostId ?? ""):\(descriptor.instanceId ?? "")"
        if identity != currentIdentity { cached = nil; etag = nil; identity = currentIdentity }
        var request = URLRequest(url: baseURL.appending(path: "api/local/snapshot"))
        request.setValue(etag, forHTTPHeaderField: "If-None-Match")
        let (data, response) = try await LocalServiceConnection().data(for: request, using: session)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        if http.statusCode == 304, let cached { return cached }
        guard http.statusCode == 200 else {
            throw (try? JSONDecoder().decode(BridgeAPIError.self, from: data))
                ?? BridgeAPIError(code: "snapshot_unavailable", message: "本机数据暂时不可用。", recoverable: true)
        }
        let next = try JSONDecoder().decode(NativeSnapshot.self, from: data)
        guard next.host?.id == descriptor.hostId else { throw LocalServiceIdentityError.mismatch }
        cached = next; etag = http.value(forHTTPHeaderField: "ETag")
        return next
    }
}

enum NativeRefreshPolicy {
    static func interval(active: Bool, hasWork: Bool, failures: Int) -> Double {
        if failures > 0 { return min(30, pow(2, Double(min(failures, 5)))) }
        return active || hasWork ? 2 : 5
    }
}
