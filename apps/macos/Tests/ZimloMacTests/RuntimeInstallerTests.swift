import Foundation
import XCTest
@testable import ZimloMac

final class RuntimeInstallerTests: XCTestCase {
    private var root: URL!

    override func setUp() {
        super.setUp()
        root = FileManager.default.temporaryDirectory
            .appending(path: "zimlo-runtime-test-\(UUID().uuidString)", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: root)
        super.tearDown()
    }

    func testManifestSelectsOnlyExactArchitectureVersionProtocolAndOrigin() throws {
        let configuration = RuntimeConfiguration(
            rootDirectory: root,
            manifestURL: URL(string: "https://cloud.zimlo.app/releases/macos/runtime-latest.json")!,
            requiredVersion: "0.3.0-7",
            expectedProtocolVersion: 5,
            expectedTeamIdentifier: "TEAM123",
            allowsAdHocSignature: false,
            developmentRuntimeURL: nil
        )
        let artifact = RuntimeArtifact(
            downloadURL: URL(string: "https://cloud.zimlo.app/releases/macos/runtime-arm64.zip")!,
            sha256: String(repeating: "a", count: 64),
            size: 42
        )
        let manifest = RuntimeReleaseManifest(
            schemaVersion: 1,
            runtimeVersion: "0.3.0-7",
            protocolVersion: 5,
            artifacts: ["arm64": artifact]
        )

        XCTAssertEqual(
            try RuntimeManifestPolicy.artifact(
                from: manifest,
                architecture: .arm64,
                configuration: configuration
            ),
            artifact
        )

        let foreign = RuntimeArtifact(
            downloadURL: URL(string: "https://example.com/runtime.zip")!,
            sha256: artifact.sha256,
            size: artifact.size
        )
        XCTAssertThrowsError(try RuntimeManifestPolicy.artifact(
            from: RuntimeReleaseManifest(
                schemaVersion: 1,
                runtimeVersion: manifest.runtimeVersion,
                protocolVersion: manifest.protocolVersion,
                artifacts: ["arm64": foreign]
            ),
            architecture: .arm64,
            configuration: configuration
        ))
    }

    func testStoreAtomicallyKeepsCurrentAndOnePreviousRuntime() throws {
        let store = RuntimeStore(rootDirectory: root)
        let first = try store.install(
            fakeRuntime(version: "0.3.0-1"),
            sha256: String(repeating: "1", count: 64)
        )
        XCTAssertEqual(store.candidates().map(\.entry.version), ["0.3.0-1"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: first.helperBundle.path))

        let second = try store.install(
            fakeRuntime(version: "0.3.0-2"),
            sha256: String(repeating: "2", count: 64)
        )
        XCTAssertEqual(store.candidates().map(\.entry.version), ["0.3.0-2", "0.3.0-1"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: first.helperBundle.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: second.helperBundle.path))

        _ = try store.install(
            fakeRuntime(version: "0.3.0-3"),
            sha256: String(repeating: "3", count: 64)
        )
        XCTAssertEqual(store.candidates().map(\.entry.version), ["0.3.0-3", "0.3.0-2"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: first.helperBundle.path))
    }

    func testFileDigestMatchesKnownSHA256() throws {
        let file = root.appending(path: "digest.txt")
        try Data("zimlo".utf8).write(to: file)
        XCTAssertEqual(
            try RuntimeFileDigest.sha256(at: file),
            "2c00f0b0518ab615fd08e62e020c700b202f464f5dba2688d402bb0528f9109e"
        )
    }

    private func fakeRuntime(version: String) throws -> ManagedRuntime {
        let helper = root.appending(path: "source-\(version)-\(UUID().uuidString).app", directoryHint: .isDirectory)
        let resources = helper.appending(path: "Contents/Resources", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
        return ManagedRuntime(
            version: version,
            architecture: .current,
            protocolVersion: 5,
            helperBundle: helper,
            executable: helper.appending(path: "Contents/MacOS/zimlo"),
            resourcesDirectory: resources
        )
    }
}
