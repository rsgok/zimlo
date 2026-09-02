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

    func testEmbeddedRuntimeInstallsWithoutNetwork() async throws {
        let version = "0.3.0-embedded"
        let archive = try makeRuntimeArchive(version: version)
        let configuration = RuntimeConfiguration(
            rootDirectory: root.appending(path: "installed", directoryHint: .isDirectory),
            manifestURL: URL(string: "https://invalid.example/runtime-latest.json")!,
            requiredVersion: version,
            expectedProtocolVersion: 5,
            expectedTeamIdentifier: nil,
            allowsAdHocSignature: true,
            embeddedRuntimeArchiveURL: archive,
            developmentRuntimeURL: nil
        )

        let runtime = try await RuntimeInstaller(configuration: configuration).resolve { _ in }

        XCTAssertEqual(runtime.version, version)
        XCTAssertEqual(runtime.architecture, .current)
        XCTAssertTrue(runtime.helperBundle.path.hasPrefix(configuration.rootDirectory.path))
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: runtime.executable.path))
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

    private func makeRuntimeArchive(version: String) throws -> URL {
        let helper = root.appending(path: "embedded/ZimloBridgeRuntime.app", directoryHint: .isDirectory)
        let executable = helper.appending(path: "Contents/MacOS/zimlo")
        let resources = helper.appending(path: "Contents/Resources", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(
            at: resources.appending(path: "public", directoryHint: .isDirectory),
            withIntermediateDirectories: true
        )
        try FileManager.default.createDirectory(
            at: executable.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let testExecutable = try XCTUnwrap(Bundle(for: RuntimeInstallerTests.self).executableURL)
        try FileManager.default.copyItem(at: testExecutable, to: executable)
        try Data("<html></html>".utf8).write(to: resources.appending(path: "public/index.html"))

        let info: [String: Any] = [
            "CFBundleIdentifier": "app.zimlo.bridge-runtime.test",
            "CFBundleExecutable": "zimlo",
            "CFBundlePackageType": "APPL",
            "CFBundleShortVersionString": version,
            "CFBundleVersion": "1",
            "ZimloProtocolVersion": 5,
            "ZimloRuntimeArchitecture": RuntimeArchitecture.current.rawValue,
        ]
        let infoData = try PropertyListSerialization.data(
            fromPropertyList: info,
            format: .xml,
            options: 0
        )
        try infoData.write(to: helper.appending(path: "Contents/Info.plist"))
        let signature = RuntimeCommand.run(
            executable: URL(fileURLWithPath: "/usr/bin/codesign"),
            arguments: ["--force", "--sign", "-", helper.path]
        )
        XCTAssertEqual(signature.status, 0, signature.output)

        let archive = root.appending(path: "ZimloRuntime-(version)-(RuntimeArchitecture.current.rawValue).zip")
        let compression = RuntimeCommand.run(
            executable: URL(fileURLWithPath: "/usr/bin/ditto"),
            arguments: ["-c", "-k", "--keepParent", helper.path, archive.path]
        )
        XCTAssertEqual(compression.status, 0, compression.output)
        return archive
    }
}
