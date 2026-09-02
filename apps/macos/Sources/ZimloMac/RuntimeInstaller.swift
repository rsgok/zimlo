import CryptoKit
import Foundation

struct RuntimeArtifact: Codable, Equatable, Sendable {
    let downloadURL: URL
    let sha256: String
    let size: Int64
}

struct RuntimeReleaseManifest: Codable, Equatable, Sendable {
    let schemaVersion: Int
    let runtimeVersion: String
    let protocolVersion: Int
    let artifacts: [String: RuntimeArtifact]
}

enum RuntimeArchitecture: String, Codable, Sendable {
    case arm64
    case x86_64

    static var current: RuntimeArchitecture {
        #if arch(arm64)
        .arm64
        #elseif arch(x86_64)
        .x86_64
        #else
        #error("Zimlo supports only arm64 and x86_64 on macOS")
        #endif
    }
}

struct ManagedRuntime: Equatable, Sendable {
    let version: String
    let architecture: RuntimeArchitecture
    let protocolVersion: Int
    let helperBundle: URL
    let executable: URL
    let resourcesDirectory: URL
}

struct RuntimeConfiguration: Sendable {
    let rootDirectory: URL
    let manifestURL: URL
    let requiredVersion: String
    let expectedProtocolVersion: Int
    let expectedTeamIdentifier: String?
    let allowsAdHocSignature: Bool
    let embeddedRuntimeArchiveURL: URL?
    let developmentRuntimeURL: URL?

    init(
        rootDirectory: URL,
        manifestURL: URL,
        requiredVersion: String,
        expectedProtocolVersion: Int,
        expectedTeamIdentifier: String?,
        allowsAdHocSignature: Bool,
        embeddedRuntimeArchiveURL: URL? = nil,
        developmentRuntimeURL: URL?
    ) {
        self.rootDirectory = rootDirectory
        self.manifestURL = manifestURL
        self.requiredVersion = requiredVersion
        self.expectedProtocolVersion = expectedProtocolVersion
        self.expectedTeamIdentifier = expectedTeamIdentifier
        self.allowsAdHocSignature = allowsAdHocSignature
        self.embeddedRuntimeArchiveURL = embeddedRuntimeArchiveURL
        self.developmentRuntimeURL = developmentRuntimeURL
    }

    static func live(bundle: Bundle = .main) -> RuntimeConfiguration {
        let info = bundle.infoDictionary ?? [:]
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first
            ?? FileManager.default.homeDirectoryForCurrentUser
                .appending(path: "Library/Application Support", directoryHint: .isDirectory)
        let manifestValue = info["ZimloRuntimeManifestURL"] as? String
        let manifestURL = manifestValue.flatMap(URL.init(string:))
            ?? URL(string: "https://cloud.zimlo.app/releases/macos/runtime-latest.json")!
        let appVersion = info["CFBundleShortVersionString"] as? String ?? "0.3.1"
        let build = info["CFBundleVersion"] as? String ?? "1"
        let requiredVersion = info["ZimloRequiredRuntimeVersion"] as? String
            ?? "\(appVersion)-\(build)"
        let developmentPath = (info["ZimloRuntimeDevelopmentPath"] as? String)
            .flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0, isDirectory: true) }
        let embeddedArchive = bundle.bundleURL
            .appending(path: "Contents/Resources/Runtime/ZimloRuntime.zip")
        let embeddedRuntimeArchiveURL = FileManager.default.fileExists(atPath: embeddedArchive.path)
            ? embeddedArchive
            : nil

        return RuntimeConfiguration(
            rootDirectory: appSupport
                .appending(path: "Zimlo", directoryHint: .isDirectory)
                .appending(path: "Runtime", directoryHint: .isDirectory),
            manifestURL: manifestURL,
            requiredVersion: requiredVersion,
            expectedProtocolVersion: ZimloContract.protocolVersion,
            expectedTeamIdentifier: info["ZimloRuntimeTeamIdentifier"] as? String,
            allowsAdHocSignature: info["ZimloAllowsAdHocRuntime"] as? Bool ?? false,
            embeddedRuntimeArchiveURL: embeddedRuntimeArchiveURL,
            developmentRuntimeURL: developmentPath
        )
    }
}

enum RuntimeManifestPolicy {
    static func artifact(
        from manifest: RuntimeReleaseManifest,
        architecture: RuntimeArchitecture,
        configuration: RuntimeConfiguration
    ) throws -> RuntimeArtifact {
        guard manifest.schemaVersion == 1 else {
            throw RuntimeInstallerError.invalidManifest("Runtime 清单版本不受支持。")
        }
        guard manifest.runtimeVersion == configuration.requiredVersion,
              validVersion(manifest.runtimeVersion) else {
            throw RuntimeInstallerError.invalidManifest("Runtime 版本与当前 Zimlo 不匹配。")
        }
        guard manifest.protocolVersion == configuration.expectedProtocolVersion else {
            throw RuntimeInstallerError.invalidManifest("Runtime 协议与当前 Zimlo 不兼容。")
        }
        guard let artifact = manifest.artifacts[architecture.rawValue],
              artifact.downloadURL.scheme == "https",
              artifact.downloadURL.host == configuration.manifestURL.host,
              artifact.size > 0,
              validSHA256(artifact.sha256) else {
            throw RuntimeInstallerError.invalidManifest("Runtime 下载信息无效。")
        }
        return artifact
    }

    static func validVersion(_ value: String) -> Bool {
        !value.isEmpty
            && value.count <= 96
            && value.unicodeScalars.allSatisfy {
                CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
                    .contains($0)
            }
    }

    static func validSHA256(_ value: String) -> Bool {
        value.count == 64 && value.allSatisfy { $0.isHexDigit }
    }
}

actor RuntimeInstaller {
    typealias Progress = @MainActor @Sendable (String?) -> Void

    private let configuration: RuntimeConfiguration
    private let session: URLSession

    init(configuration: RuntimeConfiguration = .live(), session: URLSession? = nil) {
        self.configuration = configuration
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.ephemeral
            config.timeoutIntervalForRequest = 30
            config.timeoutIntervalForResource = 10 * 60
            config.requestCachePolicy = .reloadIgnoringLocalCacheData
            self.session = URLSession(configuration: config)
        }
    }

    func resolve(progress: Progress) async throws -> ManagedRuntime {
        let validator = RuntimeValidator(configuration: configuration)
        if let developmentRuntimeURL = configuration.developmentRuntimeURL {
            await progress("正在验证本地开发 Runtime…")
            let runtime = try validator.validate(
                helperBundle: developmentRuntimeURL,
                requiredVersion: configuration.requiredVersion
            )
            await progress(nil)
            return runtime
        }

        let store = RuntimeStore(rootDirectory: configuration.rootDirectory)
        let installed = store.candidates().compactMap { candidate in
            try? validator.validate(helperBundle: candidate.helperBundle, requiredVersion: nil)
        }
        if let exact = installed.first(where: { $0.version == configuration.requiredVersion }) {
            await progress(nil)
            return exact
        }

        var embeddedFailure: Error?
        if let embeddedArchive = configuration.embeddedRuntimeArchiveURL {
            do {
                await progress("正在安装随 Zimlo 提供的 Bridge Runtime…")
                let installedRuntime = try install(
                    archive: embeddedArchive,
                    expectedArtifact: nil,
                    validator: validator,
                    store: store
                )
                await progress(nil)
                return installedRuntime
            } catch {
                embeddedFailure = error
            }
        }

        do {
            await progress("正在获取适合这台 Mac 的 Bridge Runtime…")
            let manifest = try await fetchManifest()
            let artifact = try RuntimeManifestPolicy.artifact(
                from: manifest,
                architecture: .current,
                configuration: configuration
            )
            await progress("正在下载 Bridge Runtime…")
            let archive = try await download(artifact)
            defer { try? FileManager.default.removeItem(at: archive) }

            await progress("正在校验并安装 Bridge Runtime…")
            let installedRuntime = try install(
                archive: archive,
                expectedArtifact: artifact,
                validator: validator,
                store: store
            )
            await progress(nil)
            return installedRuntime
        } catch {
            if let fallback = installed.first(where: {
                $0.protocolVersion == configuration.expectedProtocolVersion
            }) {
                await progress("Runtime 更新暂不可用，正在使用上一版。")
                return fallback
            }
            await progress(nil)
            if let embeddedFailure {
                throw embeddedFailure
            }
            throw error
        }
    }

    private func install(
        archive: URL,
        expectedArtifact: RuntimeArtifact?,
        validator: RuntimeValidator,
        store: RuntimeStore
    ) throws -> ManagedRuntime {
        let digest = try RuntimeFileDigest.sha256(at: archive)
        if let expectedArtifact {
            guard digest.caseInsensitiveCompare(expectedArtifact.sha256) == .orderedSame else {
                throw RuntimeInstallerError.integrityMismatch
            }
            let size = try archive.resourceValues(forKeys: [.fileSizeKey]).fileSize.map(Int64.init) ?? 0
            guard size == expectedArtifact.size else {
                throw RuntimeInstallerError.integrityMismatch
            }
        }

        let stagingDirectory = configuration.rootDirectory
            .appending(path: "staging-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(
            at: configuration.rootDirectory,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: stagingDirectory) }
        try RuntimeArchive.extract(archive, to: stagingDirectory)
        let helper = stagingDirectory
            .appending(path: "ZimloBridgeRuntime.app", directoryHint: .isDirectory)
        let runtime = try validator.validate(
            helperBundle: helper,
            requiredVersion: configuration.requiredVersion
        )
        return try store.install(runtime, sha256: digest)
    }

    private func fetchManifest() async throws -> RuntimeReleaseManifest {
        var request = URLRequest(url: configuration.manifestURL)
        request.timeoutInterval = 30
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse,
              response.statusCode == 200 else {
            throw RuntimeInstallerError.downloadFailed
        }
        do {
            return try JSONDecoder().decode(RuntimeReleaseManifest.self, from: data)
        } catch {
            throw RuntimeInstallerError.invalidManifest("Runtime 清单无法读取。")
        }
    }

    private func download(_ artifact: RuntimeArtifact) async throws -> URL {
        var request = URLRequest(url: artifact.downloadURL)
        request.timeoutInterval = 10 * 60
        let (temporaryURL, response) = try await session.download(for: request)
        guard let response = response as? HTTPURLResponse,
              response.statusCode == 200 else {
            throw RuntimeInstallerError.downloadFailed
        }
        let destination = FileManager.default.temporaryDirectory
            .appending(path: "zimlo-runtime-\(UUID().uuidString).zip")
        try FileManager.default.moveItem(at: temporaryURL, to: destination)
        return destination
    }
}

struct RuntimeStore {
    struct Entry: Codable, Equatable, Sendable {
        let version: String
        let architecture: RuntimeArchitecture
        let protocolVersion: Int
        let relativePath: String
        let sha256: String
    }

    struct Pointer: Codable, Equatable, Sendable {
        let current: Entry
        let previous: Entry?
    }

    struct Candidate: Equatable, Sendable {
        let entry: Entry
        let helperBundle: URL
    }

    let rootDirectory: URL

    private var versionsDirectory: URL {
        rootDirectory.appending(path: "versions", directoryHint: .isDirectory)
    }

    private var pointerURL: URL {
        rootDirectory.appending(path: "current.json")
    }

    func candidates() -> [Candidate] {
        guard let data = try? Data(contentsOf: pointerURL),
              let pointer = try? JSONDecoder().decode(Pointer.self, from: data) else { return [] }
        return [pointer.current, pointer.previous].compactMap { entry in
            guard let entry,
                  safeRelativePath(entry.relativePath) else { return nil }
            return Candidate(
                entry: entry,
                helperBundle: rootDirectory.appending(path: entry.relativePath, directoryHint: .isDirectory)
            )
        }
    }

    func install(_ runtime: ManagedRuntime, sha256: String) throws -> ManagedRuntime {
        guard RuntimeManifestPolicy.validVersion(runtime.version),
              RuntimeManifestPolicy.validSHA256(sha256) else {
            throw RuntimeInstallerError.invalidRuntime("Runtime 元数据无效。")
        }
        try FileManager.default.createDirectory(at: versionsDirectory, withIntermediateDirectories: true)
        let key = "\(runtime.version)-\(runtime.architecture.rawValue)-\(sha256.prefix(12))"
        let versionDirectory = versionsDirectory.appending(path: key, directoryHint: .isDirectory)
        let destination = versionDirectory
            .appending(path: "ZimloBridgeRuntime.app", directoryHint: .isDirectory)
        if FileManager.default.fileExists(atPath: versionDirectory.path) {
            try FileManager.default.removeItem(at: versionDirectory)
        }
        try FileManager.default.createDirectory(at: versionDirectory, withIntermediateDirectories: true)
        try FileManager.default.moveItem(at: runtime.helperBundle, to: destination)

        let relativePath = "versions/\(key)/ZimloBridgeRuntime.app"
        let entry = Entry(
            version: runtime.version,
            architecture: runtime.architecture,
            protocolVersion: runtime.protocolVersion,
            relativePath: relativePath,
            sha256: sha256.lowercased()
        )
        let existing = candidates().first?.entry
        let pointer = Pointer(current: entry, previous: existing == entry ? nil : existing)
        let pointerData = try JSONEncoder().encode(pointer)
        try pointerData.write(to: pointerURL, options: .atomic)
        try cleanup(keeping: Set([pointer.current.relativePath, pointer.previous?.relativePath].compactMap { $0 }))

        return ManagedRuntime(
            version: runtime.version,
            architecture: runtime.architecture,
            protocolVersion: runtime.protocolVersion,
            helperBundle: destination,
            executable: destination.appending(path: "Contents/MacOS/zimlo"),
            resourcesDirectory: destination.appending(path: "Contents/Resources", directoryHint: .isDirectory)
        )
    }

    private func cleanup(keeping relativePaths: Set<String>) throws {
        let keptDirectories = Set(relativePaths.map { path in
            String(path.split(separator: "/").prefix(2).joined(separator: "/"))
        })
        guard let children = try? FileManager.default.contentsOfDirectory(
            at: versionsDirectory,
            includingPropertiesForKeys: nil
        ) else { return }
        for child in children {
            let relative = "versions/\(child.lastPathComponent)"
            if !keptDirectories.contains(relative) {
                try FileManager.default.removeItem(at: child)
            }
        }
    }

    private func safeRelativePath(_ value: String) -> Bool {
        value.hasPrefix("versions/")
            && value.hasSuffix("/ZimloBridgeRuntime.app")
            && !value.contains("..")
            && !value.hasPrefix("/")
    }
}

struct RuntimeValidator {
    let configuration: RuntimeConfiguration

    func validate(helperBundle: URL, requiredVersion: String?) throws -> ManagedRuntime {
        let infoURL = helperBundle.appending(path: "Contents/Info.plist")
        guard let info = NSDictionary(contentsOf: infoURL) as? [String: Any],
              let version = info["CFBundleShortVersionString"] as? String,
              let architectureValue = info["ZimloRuntimeArchitecture"] as? String,
              let architecture = RuntimeArchitecture(rawValue: architectureValue),
              let protocolVersion = info["ZimloProtocolVersion"] as? Int else {
            throw RuntimeInstallerError.invalidRuntime("Runtime 元数据缺失。")
        }
        if let requiredVersion, version != requiredVersion {
            throw RuntimeInstallerError.invalidRuntime("Runtime 版本不匹配。")
        }
        guard RuntimeManifestPolicy.validVersion(version),
              architecture == .current,
              protocolVersion == configuration.expectedProtocolVersion else {
            throw RuntimeInstallerError.invalidRuntime("Runtime 与这台 Mac 不兼容。")
        }

        let executable = helperBundle.appending(path: "Contents/MacOS/zimlo")
        let resourcesDirectory = helperBundle
            .appending(path: "Contents/Resources", directoryHint: .isDirectory)
        let webIndex = resourcesDirectory.appending(path: "public/index.html")
        guard FileManager.default.isExecutableFile(atPath: executable.path),
              FileManager.default.fileExists(atPath: webIndex.path) else {
            throw RuntimeInstallerError.invalidRuntime("Runtime 文件不完整。")
        }

        let architectureCheck = RuntimeCommand.run(
            executable: URL(fileURLWithPath: "/usr/bin/lipo"),
            arguments: [executable.path, "-verify_arch", architecture.rawValue]
        )
        guard architectureCheck.status == 0 else {
            throw RuntimeInstallerError.invalidRuntime("Runtime 架构校验失败。")
        }
        let signatureCheck = RuntimeCommand.run(
            executable: URL(fileURLWithPath: "/usr/bin/codesign"),
            arguments: ["--verify", "--deep", "--strict", helperBundle.path]
        )
        guard signatureCheck.status == 0 else {
            throw RuntimeInstallerError.invalidSignature
        }
        let signatureInfo = RuntimeCommand.run(
            executable: URL(fileURLWithPath: "/usr/bin/codesign"),
            arguments: ["-d", "--verbose=4", helperBundle.path]
        )
        guard signatureInfo.status == 0 else {
            throw RuntimeInstallerError.invalidSignature
        }
        if let expectedTeamIdentifier = configuration.expectedTeamIdentifier,
           !expectedTeamIdentifier.isEmpty {
            guard signatureInfo.output.contains("TeamIdentifier=\(expectedTeamIdentifier)") else {
                throw RuntimeInstallerError.invalidSignature
            }
        } else if !configuration.allowsAdHocSignature {
            throw RuntimeInstallerError.invalidSignature
        }

        return ManagedRuntime(
            version: version,
            architecture: architecture,
            protocolVersion: protocolVersion,
            helperBundle: helperBundle,
            executable: executable,
            resourcesDirectory: resourcesDirectory
        )
    }
}

enum RuntimeFileDigest {
    static func sha256(at url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let data = try handle.read(upToCount: 1024 * 1024), !data.isEmpty {
            hasher.update(data: data)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

enum RuntimeArchive {
    static func extract(_ archive: URL, to directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let result = RuntimeCommand.run(
            executable: URL(fileURLWithPath: "/usr/bin/ditto"),
            arguments: ["-x", "-k", archive.path, directory.path]
        )
        guard result.status == 0 else {
            throw RuntimeInstallerError.invalidRuntime("Runtime 压缩包无法解开。")
        }
    }
}

enum RuntimeCommand {
    struct Result: Sendable {
        let status: Int32
        let output: String
    }

    static func run(executable: URL, arguments: [String]) -> Result {
        let process = Process()
        let output = Pipe()
        process.executableURL = executable
        process.arguments = arguments
        process.standardOutput = output
        process.standardError = output
        do {
            try process.run()
            process.waitUntilExit()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            return Result(
                status: process.terminationStatus,
                output: String(data: data, encoding: .utf8) ?? ""
            )
        } catch {
            return Result(status: -1, output: error.localizedDescription)
        }
    }
}

enum RuntimeInstallerError: LocalizedError {
    case invalidManifest(String)
    case downloadFailed
    case integrityMismatch
    case invalidSignature
    case invalidRuntime(String)

    var errorDescription: String? {
        switch self {
        case .invalidManifest(let message), .invalidRuntime(let message):
            message
        case .downloadFailed:
            "Bridge Runtime 下载失败，请检查网络后重试。"
        case .integrityMismatch:
            "Bridge Runtime 完整性校验失败，已拒绝安装。"
        case .invalidSignature:
            "Bridge Runtime 签名无效，已拒绝运行。"
        }
    }
}
