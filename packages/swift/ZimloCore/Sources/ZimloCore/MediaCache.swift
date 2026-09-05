import CryptoKit
import Foundation
import ImageIO
import SwiftUI

public actor ThumbnailRepository {
    public static let shared = ThumbnailRepository()
    private let cache = NSCache<NSString, CGImage>()
    public init() { cache.totalCostLimit = 48 * 1_024 * 1_024; cache.countLimit = 128 }
    public func image(url: URL, maxPixel: Int) -> CGImage? {
        let attributes = try? url.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
        let key = "\(url.absoluteString):\(maxPixel):\(attributes?.contentModificationDate?.timeIntervalSince1970 ?? 0):\(attributes?.fileSize ?? 0)" as NSString
        if let value = cache.object(forKey: key) { return value }
        guard !Task.isCancelled, let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              let value = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceShouldCacheImmediately: true,
                kCGImageSourceThumbnailMaxPixelSize: min(2_048, max(1, maxPixel))] as CFDictionary) else { return nil }
        cache.setObject(value, forKey: key, cost: value.bytesPerRow * value.height)
        return value
    }
}
public struct DownsampledImage: View {
    let url: URL
    let maxPixel: Int
    @State private var image: CGImage?
    public init(url: URL, maxPixel: Int = 1_440) { self.url = url; self.maxPixel = maxPixel }
    public var body: some View {
        Group {
            if let image { Image(decorative: image, scale: 1).resizable() }
            else { Image(systemName: "photo").resizable().scaledToFit().padding() }
        }.task(id: "\(url.absoluteString):\(maxPixel)") {
            let next = await ThumbnailRepository.shared.image(url: url, maxPixel: maxPixel)
            guard !Task.isCancelled else { return }; image = next
        }
    }
}

/// Only received, re-downloadable files live here. Unsent user attachments stay
/// in Application Support and are never considered for automatic eviction.
public actor DownloadedMaterialCache {
    public static let shared = DownloadedMaterialCache()
    private let root: URL
    private let byteLimit: Int
    public init(root: URL? = nil, byteLimit: Int = 256 * 1_024 * 1_024) {
        self.root = root ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appending(path: "Zimlo/ReceivedMaterials")
        self.byteLimit = byteLimit
    }
    private func file(host: String, id: String, sha256: String, name: String) -> URL {
        let key = SHA256.hash(data: Data("\(host):\(id):\(sha256)".utf8)).map { String(format: "%02x", $0) }.joined()
        let ext = URL(fileURLWithPath: name).pathExtension.filter { $0.isASCII && ($0.isLetter || $0.isNumber) }.prefix(12)
        return root.appending(path: ext.isEmpty ? key : "\(key).\(ext)")
    }
    public func url(host: String, id: String, sha256: String, name: String) -> URL? {
        let url = file(host: host, id: id, sha256: sha256, name: name)
        guard let data = try? Data(contentsOf: url, options: .mappedIfSafe) else { return nil }
        guard SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() == sha256 else { try? FileManager.default.removeItem(at: url); return nil }
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
        return url
    }
    public func save(_ data: Data, host: String, id: String, sha256: String, name: String) throws -> URL {
        guard data.count <= byteLimit, SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() == sha256 else { throw CocoaError(.fileReadCorruptFile) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let url = file(host: host, id: id, sha256: sha256, name: name)
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        let keys: Set<URLResourceKey> = [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey]
        let files = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: Array(keys))) ?? []
        let entries = files.compactMap { file -> (URL, Int, Date)? in
            guard let info = try? file.resourceValues(forKeys: keys), info.isRegularFile == true else { return nil }
            return (file, info.fileSize ?? 0, info.contentModificationDate ?? .distantPast)
        }.sorted { $0.2 < $1.2 }
        var total = entries.reduce(0) { $0 + $1.1 }
        for entry in entries where entry.0 != url && (total > byteLimit || entry.2 < Date().addingTimeInterval(-7 * 86_400)) {
            try FileManager.default.removeItem(at: entry.0); total -= entry.1
        }
        return url
    }
}
