import Foundation

public struct HistoryRequestError: LocalizedError, Sendable {
    public let message: String
    public var errorDescription: String? { message }
    public init(_ message: String) { self.message = message }
}

@MainActor public final class HistoryRequestBroker {
    private struct Pending {
        let hostId: String
        let continuation: CheckedContinuation<HistoryPage, Error>
        let timeout: Task<Void, Never>
    }
    private var pending: [String: Pending] = [:]
    public init() {}
    public func request(_ query: HistorySearch, hostId: String, send: (HistorySearch) -> Bool) async throws -> HistoryPage {
        let id = query.requestId
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                let timeout = Task { [weak self] in
                    do { try await Task.sleep(for: .seconds(15)) } catch { return }
                    self?.fail(id: id, hostId: hostId, message: "运行设备暂未返回历史成果。请检查连接，或更新运行设备后重试。")
                }
                pending[id] = Pending(hostId: hostId, continuation: continuation, timeout: timeout)
                if !send(query) { fail(id: id, hostId: hostId, message: "运行设备当前离线。恢复连接后可以重新检索。") }
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                guard let value = self?.pending.removeValue(forKey: id) else { return }
                value.timeout.cancel(); value.continuation.resume(throwing: CancellationError())
            }
        }
    }
    public func receive(_ page: HistoryPage) {
        guard pending[page.requestId]?.hostId == page.hostId, let value = pending.removeValue(forKey: page.requestId) else { return }
        value.timeout.cancel(); value.continuation.resume(returning: page)
    }
    public func fail(id: String, hostId: String, message: String) {
        guard pending[id]?.hostId == hostId, let value = pending.removeValue(forKey: id) else { return }
        value.timeout.cancel(); value.continuation.resume(throwing: HistoryRequestError(message))
    }
}
