import Combine
import QuickLook
import SwiftUI
import ZimloCore

struct GalleryBoundsPreferenceKey: PreferenceKey {
    static let defaultValue: CGRect = .null
    static func reduce(value: inout CGRect, nextValue: () -> CGRect) { value = value.union(nextValue()) }
}

struct GalleryItem: Identifiable, Hashable {
    let id: String
    let material: Material?
    let ordinal: Int
    var name: String { material?.name ?? "图片 \(ordinal)" }
    var key: String { "\(material?.hostId ?? "unknown"):\(id):\(material?.sha256 ?? "pending")" }

    static func resolve(ids: [String], materials: [Material], hostID: String?) -> [Self] {
        var seen = Set<String>()
        return ids.filter { seen.insert($0).inserted }.enumerated().map { index, id in
            let candidates = materials.filter { $0.id == id && $0.kind == "image" }
            var material = hostID.flatMap { host in candidates.first { $0.hostId == host } }
            if material == nil, candidates.count == 1, candidates[0].hostId == nil || hostID == nil {
                material = candidates[0]
            }
            if material?.hostId == nil { material?.hostId = hostID }
            return Self(id: id, material: material, ordinal: index + 1)
        }
    }
    static func selection(_ selected: String?, in items: [Self]) -> String? {
        items.contains { $0.id == selected } ? selected : items.first?.id
    }
}

@MainActor final class GalleryStore: ObservableObject {
    @Published private(set) var urls: [String: URL] = [:]
    @Published private(set) var errors: [String: String] = [:]
    @Published private(set) var loading: String?
    private var generation = UUID()

    func load(_ items: [GalleryItem], selected: String?, fetch: (Material) async throws -> URL) async {
        let token = UUID(); generation = token
        let keys = Set(items.map(\.key))
        urls = urls.filter { keys.contains($0.key) }
        errors = errors.filter { keys.contains($0.key) }
        let ordered = items.filter { $0.id == selected } + items.filter { $0.id != selected }
        defer { if generation == token { loading = nil } }
        for item in ordered where urls[item.key] == nil {
            guard !Task.isCancelled, generation == token else { return }
            guard let material = item.material else { errors[item.key] = "正在同步文件信息"; continue }
            guard material.status == "ready" else { errors[item.key] = "文件尚未就绪，请稍后重试"; continue }
            loading = item.key; errors[item.key] = nil
            do {
                let url = try await fetch(material)
                guard !Task.isCancelled, generation == token else { return }
                urls[item.key] = url
            } catch {
                guard !Task.isCancelled, generation == token else { return }
                errors[item.key] = "图片暂不可用，请检查来源设备后重试"
            }
        }
    }
}

struct ArtifactGallery: View {
    let items: [GalleryItem]
    let connected: Bool
    var fullBleed = false
    let fetch: (Material) async throws -> URL
    @StateObject private var store = GalleryStore()
    @State private var selectedID: String?
    @State private var retry = 0
    @State private var preview: GalleryItem?
    private var selected: GalleryItem? { items.first { $0.id == GalleryItem.selection(selectedID, in: items) } }
    private var loadID: String { items.map { "\($0.key):\($0.material?.status ?? "missing")" }.joined(separator: "|") + ":\(connected):\(selected?.id ?? ""):\(retry)" }
    private var selection: Binding<String?> {
        Binding(get: { selected?.id }, set: { selectedID = $0 })
    }

    var body: some View {
        Group {
            if items.isEmpty { ContentUnavailableView("尚无图片", systemImage: "photo") }
            else {
                TabView(selection: selection) {
                    ForEach(items) { item in
                        page(item).tag(Optional(item.id))
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: .never))
                .overlay(alignment: .topTrailing) {
                    if let selected, items.count > 1 {
                        Text("\(selected.ordinal) / \(items.count)")
                            .font(.subheadline.monospacedDigit().bold())
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .background(.black.opacity(0.72), in: Capsule()).padding(16)
                            .allowsHitTesting(false)
                    }
                }
                .overlay(alignment: .bottomLeading) {
                    if !fullBleed {
                        Label(items.count > 1 ? "左右滑动 · 查看原图" : "查看原图", systemImage: "arrow.up.left.and.arrow.down.right")
                            .font(.caption.weight(.semibold)).padding(10)
                            .background(.black.opacity(0.72), in: Capsule()).padding(16)
                            .allowsHitTesting(false)
                    }
                }
            }
        }
        .foregroundStyle(.white)
        .background(Color(red: 0.07, green: 0.11, blue: 0.09))
        .background(GeometryReader { geometry in
            Color.clear.preference(key: GalleryBoundsPreferenceKey.self, value: geometry.frame(in: .named("feed-card")))
        })
        .task(id: loadID) { await store.load(items, selected: selected?.id, fetch: fetch) }
        .sheet(item: $preview) { item in
            GalleryQuickLook(items: items.compactMap { candidate in
                store.urls[candidate.key].map { GalleryPreviewFile(id: candidate.id, name: candidate.name, url: $0, version: candidate.material?.sha256) }
            }, selectedID: item.id)
        }
    }

    private func page(_ item: GalleryItem) -> some View {
        Button {
            if store.urls[item.key] != nil { preview = item; ExperienceMetrics.shared.record(.artifactOpened) }
            else { retry += 1 }
        } label: {
            GeometryReader { geometry in
                Group {
                    if let url = store.urls[item.key] {
                        DownsampledImage(url: url).scaledToFill()
                    } else {
                        VStack(spacing: 10) {
                            if store.loading == item.key { ProgressView().tint(.white) }
                            else { Image(systemName: "photo.badge.arrow.down").font(.title2) }
                            Text(store.errors[item.key] ?? "准备预览").font(.callout)
                            if store.loading != item.key { Text("点按重试").font(.caption) }
                        }.padding()
                    }
                }.frame(width: geometry.size.width, height: geometry.size.height).clipped()
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(item.name)，第 \(item.ordinal) 张，共 \(items.count) 张")
        .accessibilityHint("点按查看完整原图，左右滑动切换图片")
        .accessibilityIdentifier("artifact-gallery-main-\(item.ordinal)")
        .accessibilityAction(named: "下一张") { if item.ordinal < items.count { selectedID = items[item.ordinal].id } }
        .accessibilityAction(named: "上一张") { if item.ordinal > 1 { selectedID = items[item.ordinal - 2].id } }
    }
}

struct GalleryPreviewFile: Identifiable {
    let id: String
    let name: String
    let url: URL
    var version: String? = nil
}
private struct GalleryQuickLook: UIViewControllerRepresentable {
    let items: [GalleryPreviewFile]
    let selectedID: String
    @Environment(\.dismiss) private var dismiss
    func makeCoordinator() -> Coordinator { Coordinator(items, close: { dismiss() }) }
    func makeUIViewController(context: Context) -> UINavigationController {
        let view = QLPreviewController(); view.dataSource = context.coordinator
        view.currentPreviewItemIndex = items.firstIndex { $0.id == selectedID } ?? 0
        view.navigationItem.rightBarButtonItem = UIBarButtonItem(
            title: "完成", style: .done, target: context.coordinator, action: #selector(Coordinator.closePreview))
        return UINavigationController(rootViewController: view)
    }
    func updateUIViewController(_ view: UINavigationController, context: Context) {
        // Freeze the open viewer's file list so background downloads cannot move its current page.
    }
    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        let items: [GalleryPreviewFile]
        let close: () -> Void
        init(_ items: [GalleryPreviewFile], close: @escaping () -> Void) { self.items = items; self.close = close }
        @objc func closePreview() { close() }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { items.count }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> any QLPreviewItem {
            Item(items[index])
        }
    }
    final class Item: NSObject, QLPreviewItem {
        let file: GalleryPreviewFile
        init(_ file: GalleryPreviewFile) { self.file = file }
        var previewItemURL: URL? { file.url }
        var previewItemTitle: String? { file.version.map { "\(file.name) · \($0.prefix(8))" } ?? file.name }
    }
}

#if DEBUG
/// Uses receipts exported by the real encrypted delivery smoke test. Never starts
/// a Bridge connection or writes test snapshots to the user's normal cache.
struct ArtifactDeliveryReview: View {
    struct Receipt: Decodable { let post: FeedPost; let materials: [Material]; let urls: [String: String] }
    let directory: String
    @StateObject private var model = AppModel()
    @State private var receipt: Receipt?
    @State private var error: String?
    var body: some View {
        VStack(spacing: 6) {
            Text("隔离成果验收").font(.caption).foregroundStyle(.secondary)
            if let receipt {
                FeedPage(model: model, entry: FeedEntry(
                    id: "post:\(receipt.post.id)", createdAt: receipt.post.createdAt, needsAction: false,
                    unread: false, settledReview: false, priority: 0, sessionId: receipt.post.sessionId, content: .post(receipt.post)
                ), materialLoader: { material in
                    guard let path = receipt.urls[material.id] else { throw URLError(.fileDoesNotExist) }
                    return URL(fileURLWithPath: path)
                })
            } else { Text(error ?? "正在读取验收回执") }
        }.padding(.vertical, 12).preferredColorScheme(.dark).task {
            do {
                let value = try JSONDecoder().decode(Receipt.self, from: Data(contentsOf: URL(fileURLWithPath: directory).appending(path: "receipt.json")))
                model.snapshot.materials = value.materials; receipt = value
            } catch { self.error = String(describing: error) }
        }
    }
}
#endif
