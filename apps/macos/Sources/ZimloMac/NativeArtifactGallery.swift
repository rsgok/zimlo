import AppKit
import CryptoKit
import Quartz
import SwiftUI
import ZimloCore

enum NativeArtifactFile {
    static func load(_ material: Material, hostID: String, source: URL,
                     cache: DownloadedMaterialCache = .shared) async throws -> URL {
        guard material.kind == "image", material.status == "ready",
              material.hostId == nil || material.hostId == hostID else { throw LocalServiceIdentityError.mismatch }
        if let url = await cache.url(host: hostID, id: material.id, sha256: material.sha256, name: material.name) { return url }
        let data: Data
        if source.isFileURL {
            data = try Data(contentsOf: source, options: .mappedIfSafe)
        } else {
            var request = URLRequest(url: source, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
            request.setValue(hostID, forHTTPHeaderField: "X-Zimlo-Host-ID")
            let (bytes, response) = try await LocalServiceConnection().data(for: request, using: .shared)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
            data = bytes
        }
        try Task.checkCancellation()
        return try await cache.save(data, host: hostID, id: material.id, sha256: material.sha256, name: material.name)
    }
}

struct NativeArtifactGallery: View {
    let ids: [String]
    let materials: [Material]
    let hostID: String
    let source: (Material) -> URL
    var opened: () -> Void = {}
    @State private var selectedID: String?
    @State private var loaded: Loaded?
    @State private var failure: String?
    @State private var retry = 0
    @State private var preview: Loaded?
    @FocusState private var galleryFocused: Bool
    private struct Loaded: Identifiable {
        let id: String
        let material: Material
        let url: URL
    }
    private var orderedIDs: [String] {
        var seen = Set<String>()
        return ids.filter { seen.insert($0).inserted }
    }
    private var index: Int { orderedIDs.firstIndex(of: selectedID ?? "") ?? 0 }
    private var selected: Material? {
        guard orderedIDs.indices.contains(index) else { return nil }
        return materials.first { $0.id == orderedIDs[index] && ($0.hostId == nil || $0.hostId == hostID) }
    }
    private var key: String { "\(hostID):\(orderedIDs.indices.contains(index) ? orderedIDs[index] : "empty"):\(selected?.sha256 ?? "missing"):\(selected?.status ?? "missing")" }
    private var current: Loaded? { loaded?.id == key ? loaded : nil }

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Color(red: 0.05, green: 0.08, blue: 0.06)
                Button { if let current { preview = current; opened() } else { retry += 1 } } label: {
                    Group {
                        if let current { DownsampledImage(url: current.url, maxPixel: 2_048).scaledToFit() }
                        else {
                            VStack(spacing: 12) {
                                if failure == nil { ProgressView().tint(.white) }
                                Image(systemName: "photo").font(.largeTitle)
                                Text(failure ?? "正在加载图片").font(.callout)
                                if failure != nil { Text("点按重试").font(.caption) }
                            }.padding(20)
                        }
                    }.frame(width: geometry.size.width, height: geometry.size.height).clipped().contentShape(Rectangle())
                }.buttonStyle(.plain)
                    .accessibilityLabel("查看原图，第 \(index + 1) 张，共 \(orderedIDs.count) 张")
                if orderedIDs.count > 1 {
                    HStack {
                        navigationButton("上一张", symbol: "chevron.left", step: -1).disabled(index == 0)
                        Spacer()
                        navigationButton("下一张", symbol: "chevron.right", step: 1).disabled(index == orderedIDs.count - 1)
                    }.padding(16)
                }
            }
            .overlay(alignment: .topTrailing) {
                if orderedIDs.count > 1 {
                    Text("\(index + 1) / \(orderedIDs.count)").font(.system(size: 13, weight: .bold, design: .monospaced))
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(.black.opacity(0.72), in: Capsule()).padding(16).allowsHitTesting(false)
                }
            }
            .overlay(alignment: .bottomLeading) {
                Label("查看原图", systemImage: "arrow.up.left.and.arrow.down.right")
                    .font(.system(size: 11, weight: .semibold)).padding(10)
                    .background(.black.opacity(0.72), in: Capsule()).padding(16).allowsHitTesting(false)
            }
            .foregroundStyle(.white)
        }
        .focusable()
        .focused($galleryFocused)
        .focusEffectDisabled()
        .onKeyPress(.leftArrow) { move(-1); return .handled }
        .onKeyPress(.rightArrow) { move(1); return .handled }
        .simultaneousGesture(DragGesture(minimumDistance: 30).onEnded { value in
            guard abs(value.translation.width) > abs(value.translation.height) * 1.5 else { return }
            move(value.translation.width < 0 ? 1 : -1)
        })
        .task(id: "\(key):\(retry)") {
            let requested = key
            loaded = nil; failure = nil
            guard let selected else { failure = "图片信息尚未同步，请稍后重试"; return }
            do {
                let url = try await NativeArtifactFile.load(selected, hostID: hostID, source: source(selected))
                try Task.checkCancellation()
                guard requested == key else { return }
                loaded = Loaded(id: requested, material: selected, url: url)
            } catch {
                guard !Task.isCancelled, requested == key else { return }
                failure = "图片暂不可用，请检查来源设备后重试"
            }
        }
        .sheet(item: $preview) { item in
            VStack(spacing: 0) {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(item.material.name).font(.headline).lineLimit(1)
                        Text("版本 \(item.material.sha256.prefix(8))").font(.caption.monospaced()).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("完成") { preview = nil }.keyboardShortcut(.cancelAction)
                }.padding(18)
                NativeOriginalImage(url: item.url).frame(maxWidth: .infinity, maxHeight: .infinity)
            }.frame(minWidth: 600, idealWidth: 900, minHeight: 440, idealHeight: 680)
        }
    }

    private func move(_ step: Int) {
        galleryFocused = true
        let next = index + step
        if orderedIDs.indices.contains(next) { selectedID = orderedIDs[next] }
    }
    private func navigationButton(_ label: String, symbol: String, step: Int) -> some View {
        Button { move(step) } label: {
            Image(systemName: symbol).font(.system(size: 16, weight: .bold))
                .frame(width: 40, height: 40).background(.black.opacity(0.72), in: Circle())
        }.buttonStyle(.plain).accessibilityLabel(label).help(label)
    }
}

private struct NativeOriginalImage: NSViewRepresentable {
    let url: URL
    func makeNSView(context: Context) -> QLPreviewView {
        let view = QLPreviewView(frame: .zero, style: .normal)!
        view.autostarts = true
        view.previewItem = url as NSURL
        return view
    }
    func updateNSView(_ view: QLPreviewView, context: Context) {
        if (view.previewItem?.previewItemURL ?? nil) != url { view.previewItem = url as NSURL }
    }
}

#if DEBUG
/// Renders receipts from the isolated delivery test without starting a service.
struct NativeArtifactReview: View {
    struct Receipt: Decodable, Sendable { let host: ZimloHost; let post: FeedPost; let materials: [Material]; let urls: [String: String] }
    let directory: String
    @State private var store: NativeAppStore?
    @State private var post: FeedPost?
    @State private var failure: String?
    var body: some View {
        NavigationStack {
            ScrollView {
                if let store, let post {
                    NativeFeedCard(store: store, post: post, minimumHeight: 0).padding(24)
                } else { Text(failure ?? "读取真实文件回执…").padding(30) }
            }.background(Color.black)
        }.frame(minWidth: 740, minHeight: 640).preferredColorScheme(.dark).task {
            do {
                let receipt = try JSONDecoder().decode(Receipt.self, from: Data(contentsOf: URL(fileURLWithPath: directory).appending(path: "receipt.json")))
                var value = NativeSnapshot.empty
                value.host = receipt.host; value.materials = receipt.materials; value.posts = [receipt.post]
                let snapshot = value
                let client = NativeBridgeClient(fetchSnapshot: { snapshot }, fetchEvents: { _ in [] },
                    send: { _ in throw URLError(.notConnectedToInternet) }, importMaterial: { _ in throw URLError(.unsupportedURL) },
                    materialURL: { URL(fileURLWithPath: receipt.urls[$0] ?? "/missing-artifact") })
                let model = NativeAppStore(client: client, outbox: NativeCommandOutbox(storage: .init(read: { [] }, write: { _ in })))
                await model.refresh()
                store = model; post = receipt.post
            } catch { failure = String(describing: error) }
        }
    }
}
#endif
