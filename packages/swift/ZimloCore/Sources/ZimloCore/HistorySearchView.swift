import SwiftUI

public struct HistorySearch: Sendable, Equatable {
    public var requestId = UUID().uuidString
    public var query = ""
    public var projectId: String?
    public var after: String?
    public var kind = "all"
    public var cursor: String?
    public init() {}
}
public struct HistoryProject: Identifiable, Sendable {
    public let id: String
    public let name: String
    public init(id: String, name: String) { self.id = id; self.name = name }
}
public struct HistoryMaterial: Codable, Sendable {
    public var id: String
    public var hostId: String
    public var kind: String
    public var name: String
    public var mimeType: String
    public var sizeBytes: Int
    public var sha256: String
    public var width: Int?
    public var height: Int?
    public var durationMs: Int?
    public var previewMaterialId: String?
    public var origin: String
    public var status: String
    public var createdAt: String
}

public struct HistorySearchView: View {
    let projects: [HistoryProject]
    let sourceName: String
    let search: @MainActor (HistorySearch) async throws -> HistoryPage
    let openTask: (HistoryEntry) -> Void
    let openMaterial: (HistoryMaterial) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var project = ""
    @State private var kind = "all"
    @State private var days = 0
    @State private var afterDate: String?
    @State private var items: [HistoryEntry] = []
    @State private var materials: [String: HistoryMaterial] = [:]
    @State private var cursor: String?
    @State private var loading = false
    @State private var error: String?
    @State private var generation = UUID()
    private var filter: String { "\(query)\u{0}\(project)\u{0}\(kind)\u{0}\(days)" }
    public init(projects: [HistoryProject], sourceName: String = "", search: @escaping @MainActor (HistorySearch) async throws -> HistoryPage,
                openTask: @escaping (HistoryEntry) -> Void, openMaterial: @escaping (HistoryMaterial) -> Void) {
        self.projects = projects; self.sourceName = sourceName; self.search = search; self.openTask = openTask; self.openMaterial = openMaterial
    }
    public var body: some View {
        NavigationStack {
            List {
                Section {
                    if !sourceName.isEmpty { Text("来源：" + sourceName).font(.subheadline.weight(.semibold)) }
                    TextField("搜索结果、结论或文件名", text: $query).accessibilityLabel("搜索历史成果")
                    Picker("项目", selection: $project) { Text("全部项目").tag(""); ForEach(projects) { Text($0.name).tag($0.id) } }
                    Picker("类型", selection: $kind) { ForEach(Self.kinds, id: \.0) { Text($0.1).tag($0.0) } }
                    Picker("日期", selection: $days) { Text("全部时间").tag(0); Text("最近 7 天").tag(7); Text("最近 30 天").tag(30) }
                    Text("检索这台运行设备保存的成果，包含实时动态之外的历史内容。").font(.caption).foregroundStyle(.secondary)
                }
                if let error { Section { Text(error).foregroundStyle(.red); Button("重试") { Task { await load(more: !items.isEmpty) } } } }
                if items.isEmpty && !loading && error == nil { ContentUnavailableView("没有匹配的成果", systemImage: "magnifyingglass", description: Text("换一个关键词、项目或日期试试。")) }
                ForEach(items) { item in
                    VStack(alignment: .leading, spacing: 10) {
                        Text(item.title).font(.headline).textSelection(.enabled)
                        Text(item.createdAt.prefix(10) + " · " + (Self.kinds.first { $0.0 == item.kind }?.1 ?? item.kind)).font(.caption).foregroundStyle(.secondary)
                        if !item.summary.isEmpty { Text(item.summary).font(.body).textSelection(.enabled) }
                        if item.sessionId != nil { Button("查看任务") { openTask(item); dismiss() } }
                        ForEach(Array(Set(item.materialIds + (item.materialId.map { [$0] } ?? []))).sorted(), id: \.self) { id in
                            if let material = materials[id] {
                                Button { openMaterial(material) } label: { Label(material.name, systemImage: "doc") }
                                    .disabled(material.status != "ready")
                                Text(ByteCountFormatter.string(fromByteCount: Int64(material.sizeBytes), countStyle: .file) + " · 版本 " + material.sha256.prefix(8)).font(.caption).foregroundStyle(.secondary)
                                if material.status != "ready" { Text("文件暂不可用，请在运行设备上检查原文件。").font(.caption).foregroundStyle(.secondary) }
                            }
                        }
                    }.buttonStyle(.borderless).padding(.vertical, 8)
                }
                if loading { ProgressView("正在检索…").frame(maxWidth: .infinity) }
                if cursor != nil && !loading { Button("加载更早成果") { Task { await load(more: true) } }.frame(maxWidth: .infinity) }
            }
            .navigationTitle("历史成果")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
            .task(id: filter) {
                afterDate = days == 0 ? nil : Date().addingTimeInterval(-Double(days) * 86_400).ISO8601Format()
                generation = UUID(); items = []; materials = [:]; cursor = nil; error = nil
                do { try await Task.sleep(for: .milliseconds(300)); await load(more: false) } catch { }
            }
            .onDisappear { generation = UUID() }
        }.frame(minWidth: 300, minHeight: 400)
    }
    @MainActor private func load(more: Bool) async {
        let ticket = generation
        var request = HistorySearch(); request.query = String(query.prefix(200)); request.kind = kind
        request.projectId = project.isEmpty ? nil : project
        request.after = afterDate
        request.cursor = more ? cursor : nil
        loading = true; error = nil
        defer { if generation == ticket { loading = false } }
        do {
            let page = try await search(request)
            guard generation == ticket, !Task.isCancelled else { return }
            let previous = more ? items : []
            let existing = Set(previous.map(\.id))
            items = previous + page.items.filter { !existing.contains($0.id) }
            for material in page.materials { materials[material.id] = material }
            cursor = page.nextCursor
        } catch is CancellationError { }
        catch { if generation == ticket { self.error = error.localizedDescription } }
    }
    private static let kinds = [("all","全部类型"),("result","结果"),("failure","失败说明"),("image","图片"),("video","视频"),("pdf","PDF"),("document","文档")]
}
