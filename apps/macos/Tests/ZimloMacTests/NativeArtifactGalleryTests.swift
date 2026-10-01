import CryptoKit
import XCTest
import ZimloCore
@testable import ZimloMac

final class NativeArtifactGalleryTests: XCTestCase {
    func testFilesAreVerifiedAndHostAndVersionCannotReuseOldCache() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let source = directory.appending(path: "image.png")
        let bytes = Data("first image bytes".utf8)
        try bytes.write(to: source)
        let cache = DownloadedMaterialCache(root: directory.appending(path: "cache"))
        var material = Material(id: "same-id", hostId: "one", kind: "image", name: "image.png", mimeType: "image/png",
                                sizeBytes: bytes.count, sha256: SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined(),
                                origin: "agent", status: "ready", createdAt: "")
        let first = try await NativeArtifactFile.load(material, hostID: "one", source: source, cache: cache)
        XCTAssertEqual(try Data(contentsOf: first), bytes)
        do {
            _ = try await NativeArtifactFile.load(material, hostID: "two", source: source, cache: cache)
            XCTFail("A cached file must not cross hosts")
        } catch { XCTAssertEqual(error as? LocalServiceIdentityError, .mismatch) }
        let updated = Data("second image bytes".utf8)
        material.sha256 = SHA256.hash(data: updated).map { String(format: "%02x", $0) }.joined()
        do {
            _ = try await NativeArtifactFile.load(material, hostID: "one", source: source, cache: cache)
            XCTFail("The old file cannot satisfy the new hash")
        } catch { XCTAssertEqual((error as NSError).code, CocoaError.fileReadCorruptFile.rawValue) }
        try updated.write(to: source)
        let second = try await NativeArtifactFile.load(material, hostID: "one", source: source, cache: cache)
        XCTAssertNotEqual(first, second)
        XCTAssertEqual(try Data(contentsOf: second), updated)
    }
}
