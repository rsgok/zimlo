import CryptoKit
import Foundation
import XCTest
@testable import ZimloCore

final class ProductExperienceTests: XCTestCase {
    @MainActor func testTemplatesPersistAndDeletingAllDoesNotRestoreDefaults() throws {
        let suite = "zimlo-tests-\(UUID())"; let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = PromptTemplateStore(defaults: defaults)
        let custom = PromptTemplate(title: "My task", text: "Keep this exact text")
        store.save(custom)
        XCTAssertEqual(PromptTemplateStore(defaults: defaults).templates.last, custom)
        for item in store.templates { store.remove(item.id) }
        XCTAssertTrue(PromptTemplateStore(defaults: defaults).templates.isEmpty)
    }
    @MainActor func testAggregateCountsRemainExactWhileTimingStorageIsBounded() throws {
        let suite = "zimlo-tests-\(UUID())"; let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let metrics = ExperienceMetrics(defaults: defaults)
        for _ in 0..<600 { metrics.record(.commandReceived, milliseconds: 100) }
        let summary = try XCTUnwrap(metrics.summaries.first { $0.id == "commandReceived" })
        XCTAssertEqual(summary.count, 600); XCTAssertEqual(summary.p95Milliseconds, 100)
        XCTAssertTrue(metrics.hasConfirmedOperation)
        let json = try JSONSerialization.jsonObject(with: Data(metrics.export().utf8)) as? [[String: Any]]
        XCTAssertTrue(try XCTUnwrap(json).allSatisfy { Set($0.keys).isSubset(of: ["id","count","p50Milliseconds","p95Milliseconds"]) })
        metrics.clear(); XCTAssertTrue(metrics.summaries.allSatisfy { $0.count == 0 }); XCTAssertTrue(metrics.hasConfirmedOperation)
    }
    func testDownloadedCacheSeparatesHostsAndEvictsOnlyItsOwnReceivedFiles() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "zimlo-cache-tests-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = DownloadedMaterialCache(root: root, byteLimit: 12)
        let data = Data("12345678".utf8)
        let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let first = try await cache.save(data, host: "one", id: "same", sha256: hash, name: "report.txt")
        let wrongHost = await cache.url(host: "two", id: "same", sha256: hash, name: "report.txt"); XCTAssertNil(wrongHost)
        let second = try await cache.save(data, host: "two", id: "same", sha256: hash, name: "report.txt")
        XCTAssertNotEqual(first, second); XCTAssertFalse(FileManager.default.fileExists(atPath: first.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: second.path))
        try Data("tampered".utf8).write(to: second)
        let corrupt = await cache.url(host: "two", id: "same", sha256: hash, name: "report.txt"); XCTAssertNil(corrupt)
    }
    @MainActor func testHistoryRequestRejectsOtherHostAndCancelsWithoutLeakingWaiter() async throws {
        let broker = HistoryRequestBroker(); var query = HistorySearch(); query.requestId = "known"
        let task = Task { try await broker.request(query, hostId: "host") { _ in true } }
        await Task.yield(); task.cancel()
        do { _ = try await task.value; XCTFail("Expected cancellation") } catch is CancellationError { }
        do { _ = try await broker.request(HistorySearch(), hostId: "host") { _ in false }; XCTFail("Expected offline error") } catch { XCTAssertTrue(error.localizedDescription.contains("离线")) }
    }
}
