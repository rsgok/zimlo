import AVFoundation
import AVKit
import CryptoKit
import Foundation
import PDFKit
import QuickLook
import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct PreparedMobileMaterial: Identifiable, Hashable {
    var id: String { material.id }
    var material: Material
    var localURL: URL
    var encryptionKey: String
    var encryptedData: Data
}

enum MaterialPolicy {
    static let maxCount = 10
    static let maxTotalBytes = 80 * 1_024 * 1_024
    static let maxVideoDuration: Double = 180
    static let maxPDFPages = 200

    static func kind(mimeType: String, name: String) -> (kind: String, limit: Int)? {
        let mime = mimeType.lowercased()
        let ext = URL(fileURLWithPath: name).pathExtension.lowercased()
        if ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"].contains(mime)
            || ["jpg", "jpeg", "png", "webp", "heic", "heif"].contains(ext) { return ("image", 8 * 1_024 * 1_024) }
        if ["video/mp4", "video/quicktime", "video/x-m4v"].contains(mime)
            || ["mp4", "mov", "m4v"].contains(ext) { return ("video", 50 * 1_024 * 1_024) }
        if mime == "application/pdf" || ext == "pdf" { return ("pdf", 20 * 1_024 * 1_024) }
        let documentExtensions = ["txt", "md", "csv", "json", "doc", "docx", "xls", "xlsx", "ppt", "pptx"]
        if mime.hasPrefix("text/") || documentExtensions.contains(ext) { return ("document", 15 * 1_024 * 1_024) }
        return nil
    }

    static func prepare(data: Data, name rawName: String, mimeType: String) async throws -> PreparedMobileMaterial {
        let name = String(rawName.prefix(180))
        guard let policy = kind(mimeType: mimeType, name: name) else { throw MaterialError.message("暂不支持这种文件格式") }
        guard !data.isEmpty else { throw MaterialError.message("文件内容为空") }
        guard data.count <= policy.limit else { throw MaterialError.message("\(label(policy.kind))不能超过 \(policy.limit / 1_024 / 1_024)MB") }

        if policy.kind == "pdf", let document = PDFDocument(data: data), document.pageCount > maxPDFPages {
            throw MaterialError.message("PDF 不能超过 \(maxPDFPages) 页")
        }
        let id = "material_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let localURL = try MaterialCache.save(data: data, id: id, name: name)
        var width: Int?
        var height: Int?
        var durationMs: Int?
        if policy.kind == "image", let image = UIImage(data: data) {
            width = Int(image.size.width * image.scale)
            height = Int(image.size.height * image.scale)
        } else if policy.kind == "video" {
            let duration = try await AVURLAsset(url: localURL).load(.duration).seconds
            guard duration.isFinite, duration <= maxVideoDuration else {
                try? FileManager.default.removeItem(at: localURL)
                throw MaterialError.message("视频不能超过 3 分钟")
            }
            durationMs = Int(duration * 1_000)
        }

        let key = ZimloCrypto.randomBytes(count: 32)
        let nonce = try AES.GCM.Nonce(data: ZimloCrypto.randomBytes(count: 12))
        let sealed = try AES.GCM.seal(data, using: SymmetricKey(data: key), nonce: nonce)
        guard let encrypted = sealed.combined else { throw MaterialError.message("物料加密失败") }
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let material = Material(
            id: id, kind: policy.kind, name: name, mimeType: normalizedMIMEType(mimeType, name: name, kind: policy.kind),
            sizeBytes: data.count, sha256: digest, width: width, height: height,
            durationMs: durationMs, previewMaterialId: nil, origin: "user", status: "ready",
            createdAt: ISO8601DateFormatter().string(from: Date()), error: nil
        )
        return PreparedMobileMaterial(
            material: material,
            localURL: localURL,
            encryptionKey: ZimloCrypto.base64URL(key),
            encryptedData: encrypted
        )
    }

    static func label(_ kind: String) -> String {
        ["image": "图片", "video": "视频", "pdf": "PDF", "document": "文件"][kind] ?? "文件"
    }

    private static func normalizedMIMEType(_ rawValue: String, name: String, kind: String) -> String {
        let mime = rawValue.lowercased()
        let accepted = MaterialPolicy.kind(mimeType: mime, name: "")?.kind == kind
        if accepted { return mime }
        let ext = URL(fileURLWithPath: name).pathExtension.lowercased()
        let values = [
            "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp", "heic": "image/heic", "heif": "image/heif",
            "mp4": "video/mp4", "mov": "video/quicktime", "m4v": "video/x-m4v", "pdf": "application/pdf",
            "txt": "text/plain", "md": "text/markdown", "csv": "text/csv", "json": "application/json", "doc": "application/msword",
            "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "xls": "application/vnd.ms-excel",
            "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "ppt": "application/vnd.ms-powerpoint",
            "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ]
        return values[ext] ?? ["image": "image/jpeg", "video": "video/mp4", "pdf": "application/pdf", "document": "text/plain"][kind]!
    }
}

enum MaterialError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let value) = self { return value }; return nil }
}

enum MaterialCache {
    static func save(data: Data, id: String, name: String) throws -> URL {
        let root = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true
        ).appendingPathComponent("Materials", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let ext = URL(fileURLWithPath: name).pathExtension
        let url = root.appendingPathComponent(ext.isEmpty ? id : "\(id).\(ext)")
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        return url
    }

    static func url(for material: Material) -> URL? {
        guard let root = try? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: false
        ).appendingPathComponent("Materials", isDirectory: true),
        let values = try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
        else { return nil }
        return values.first { $0.lastPathComponent == material.id || $0.deletingPathExtension().lastPathComponent == material.id }
    }
}

struct MaterialThumbnail: View {
    let material: Material
    let url: URL?

    var body: some View {
        Group {
            if material.kind == "image", let url, let image = UIImage(contentsOfFile: url.path) {
                Image(uiImage: image).resizable().scaledToFill()
            } else if material.kind == "video" {
                Image(systemName: "play.fill").font(.title3)
            } else {
                VStack(spacing: 3) {
                    Image(systemName: material.kind == "pdf" ? "doc.richtext" : "doc")
                    Text(MaterialPolicy.label(material.kind).uppercased()).font(.system(size: 9, weight: .black, design: .monospaced))
                }
            }
        }
        .frame(width: 52, height: 52)
        .background(ZColor.raised)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

struct FeedMaterialCard: View {
    @ObservedObject var model: AppModel
    let content: FeedContent
    var fullBleed = false
    @State private var urls: [String: URL] = [:]
    @State private var previewURL: URL?
    @State private var documentText: String?
    @State private var loadError: String?
    @State private var isLoading = false

    private var referencedIDs: [String] {
        switch content.type {
        case "image_album": content.materialIds ?? []
        case "video": [content.materialId, content.posterMaterialId].compactMap { $0 }
        case "document": [content.materialId, content.coverMaterialId].compactMap { $0 }
        default: []
        }
    }
    private var materials: [Material] {
        referencedIDs.compactMap { id in model.snapshot.materials.first { $0.id == id } }
    }
    private func isReadableDocument(_ material: Material) -> Bool {
        let ext = URL(fileURLWithPath: material.name).pathExtension.lowercased()
        return material.mimeType.hasPrefix("text/") || material.mimeType == "application/json"
            || ["md", "txt", "json", "csv"].contains(ext)
    }

    private var hasReadableDocument: Bool {
        guard content.type == "document",
              let material = materials.first(where: { $0.id == content.materialId }) else { return false }
        return isReadableDocument(material)
    }

    private var hasInlinePDF: Bool {
        content.type == "document" && materials.first(where: { $0.id == content.materialId })?.kind == "pdf"
    }

    var body: some View {
        Group {
            if content.type == "image_album" {
                TabView {
                    ForEach(materials) { material in
                        if let url = urls[material.id], let image = UIImage(contentsOfFile: url.path) {
                            Image(uiImage: image).resizable().scaledToFit().tag(material.id)
                        } else { unavailable }
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: materials.count > 1 ? .automatic : .never))
            } else if content.type == "video", let material = materials.first(where: { $0.id == content.materialId }), let url = urls[material.id] {
                InlineFeedVideoPlayer(url: url)
            } else if content.type == "document", let material = materials.first(where: { $0.id == content.materialId }) {
                if isReadableDocument(material) {
                    VStack(alignment: .leading, spacing: 0) {
                        HStack(spacing: 9) {
                            Text("文档").font(ZFont.caption2.monospaced().weight(.black)).foregroundStyle(ZColor.sage)
                            Text(material.name).font(ZFont.headline).lineLimit(1)
                        }
                        .padding(.horizontal, 15).frame(height: 46)
                        Divider().overlay(ZColor.line)
                        ScrollView(.vertical) {
                            Text(readableMarkdown)
                                .font(ZFont.body)
                                .lineSpacing(4)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(18)
                        }
                        .scrollIndicators(.visible)
                        .scrollBounceBehavior(.basedOnSize)
                    }
                    .foregroundStyle(ZColor.ink)
                    .background(ZColor.raised)
                } else if material.kind == "pdf", let url = urls[material.id] {
                    VStack(spacing: 0) {
                        InlinePDFReader(url: url)
                        HStack {
                            Text(material.name).font(ZFont.caption).lineLimit(1)
                            Spacer()
                            Button("全屏阅读") { previewURL = url }
                                .font(ZFont.caption.weight(.bold))
                        }
                        .padding(.horizontal, 14).frame(height: 44)
                        .background(ZColor.raised)
                    }
                } else { Button {
                    if let url = urls[material.id] { previewURL = url }
                    else { Task { await load() } }
                } label: {
                    HStack(spacing: 14) {
                        MaterialThumbnail(material: material, url: urls[material.id])
                        VStack(alignment: .leading, spacing: 5) {
                            Text(material.name).font(ZFont.headline).lineLimit(2)
                            Text(content.summary ?? "点按预览").font(ZFont.caption2).foregroundStyle(ZColor.muted).lineLimit(2)
                        }
                        Spacer()
                        if isLoading {
                            ProgressView().tint(ZColor.muted)
                        } else {
                            Image(systemName: urls[material.id] == nil ? "arrow.clockwise" : "arrow.up.right")
                                .foregroundStyle(ZColor.muted)
                        }
                    }
                    .padding(14).foregroundStyle(ZColor.ink).background(ZColor.raised)
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
                .buttonStyle(.plain)
                }
            } else {
                unavailable
            }
        }
        .frame(
            maxWidth: .infinity,
            minHeight: fullBleed ? 0 : content.type == "document" ? 106 : 220,
            maxHeight: fullBleed ? .infinity : hasInlinePDF ? 460 : hasReadableDocument ? 330 : content.type == "document" ? 130 : 330
        )
        .background(Color.black.opacity(0.34))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .task(id: "\(referencedIDs.joined(separator: ":")):\(model.bridge.connected)") { await load() }
        .sheet(isPresented: Binding(get: { previewURL != nil }, set: { if !$0 { previewURL = nil } })) {
            if let previewURL { QuickLookSheet(url: previewURL).ignoresSafeArea() }
        }
    }

    private var readableMarkdown: AttributedString {
        guard let documentText else { return AttributedString(isLoading ? "正在读取…" : loadError ?? "物料同步中") }
        return (try? AttributedString(markdown: documentText)) ?? AttributedString(documentText)
    }

    private var unavailable: some View {
        Button { Task { await load() } } label: {
            VStack(spacing: 9) {
                if isLoading { ProgressView().tint(ZColor.muted) }
                else { Image(systemName: "arrow.triangle.2.circlepath").font(.title2) }
                Text(loadError ?? "物料同步中").font(ZFont.caption)
                if loadError != nil { Text("点按重试；连接恢复后也会自动继续").font(ZFont.caption2).foregroundStyle(ZColor.muted) }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .foregroundStyle(ZColor.muted)
        }
        .buttonStyle(.plain)
        .disabled(isLoading)
    }

    @MainActor
    private func load() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        loadError = nil
        for material in materials where urls[material.id] == nil {
            do {
                let url = try await model.localURL(for: material)
                urls[material.id] = url
                if content.type == "document", isReadableDocument(material) {
                    documentText = try await Task.detached(priority: .userInitiated) {
                        try String(contentsOf: url, encoding: .utf8)
                    }.value
                }
            }
            catch { loadError = error.localizedDescription }
        }
    }
}

private struct InlinePDFReader: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.displayDirection = .vertical
        view.displaysPageBreaks = true
        view.backgroundColor = .black
        return view
    }

    func updateUIView(_ view: PDFView, context: Context) {
        if view.document?.documentURL != url { view.document = PDFDocument(url: url) }
    }
}

private struct InlineFeedVideoPlayer: View {
    let url: URL
    @State private var player = AVPlayer()

    var body: some View {
        VideoPlayer(player: player)
            .task(id: url) {
                player.replaceCurrentItem(with: AVPlayerItem(url: url))
                player.isMuted = true
                player.play()
            }
            .onDisappear {
                player.pause()
                player.replaceCurrentItem(with: nil)
            }
    }
}

struct QuickLookSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }
    func updateUIViewController(_ controller: QLPreviewController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(url: url) }
    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        let url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    }
}
