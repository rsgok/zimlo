import SwiftUI

public struct SetupChecklistView: View {
    public let steps: [SetupMilestone]
    public let onAction: (String) -> Void
    public init(steps: [SetupMilestone], onAction: @escaping (String) -> Void) { self.steps = steps; self.onAction = onAction }
    public var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(steps.allSatisfy(\.complete) ? "已完成首次连接" : "完成首次连接").font(.headline)
            ForEach(steps) { step in
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: step.complete ? "checkmark.circle.fill" : "circle").foregroundStyle(step.complete ? .green : .secondary)
                    VStack(alignment: .leading, spacing: 3) { Text(step.title).font(.subheadline.weight(.semibold)); if !step.complete { Text(step.detail).font(.caption).foregroundStyle(.secondary) } }
                }.accessibilityElement(children: .combine)
            }
            if let next = steps.first(where: { !$0.complete }) { Button(next.title) { onAction(next.id) }.buttonStyle(.borderedProminent) }
        }
    }
}

public struct PromptTemplateLibrary: View {
    @StateObject private var store = PromptTemplateStore()
    @State private var editing: PromptTemplate?
    @Environment(\.dismiss) private var dismiss
    let onSelect: (PromptTemplate) -> Void
    public init(onSelect: @escaping (PromptTemplate) -> Void) { self.onSelect = onSelect }
    public var body: some View {
        NavigationStack {
            List {
                Section { Text("选择后填入编辑器，确认内容和目标后再发送。").font(.callout).foregroundStyle(.secondary) }
                ForEach(store.templates) { template in
                    VStack(alignment: .leading, spacing: 10) {
                        HStack { Button(template.title) { onSelect(template); dismiss() }.font(.headline); Spacer(); Button("编辑") { editing = template }.font(.callout) }
                        Text(template.text).font(.callout).foregroundStyle(.secondary).lineLimit(4)
                    }.buttonStyle(.borderless).padding(.vertical, 6)
                }.onDelete { indices in let ids = indices.map { store.templates[$0].id }; for id in ids { store.remove(id) } }
            }
            .navigationTitle("常用指令")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } }; ToolbarItem(placement: .primaryAction) { Button("新增", systemImage: "plus") { editing = PromptTemplate(title: "", text: "") } } }
            .sheet(item: $editing) { template in TemplateEditor(template: template, onSave: store.save) }
        }
        .frame(minWidth: 300, minHeight: 380)
    }
}

private struct TemplateEditor: View {
    @State var template: PromptTemplate
    let onSave: (PromptTemplate) -> Void
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Form { TextField("名称", text: $template.title); TextEditor(text: $template.text).frame(minHeight: 180).accessibilityLabel("指令正文") }
            .navigationTitle("编辑常用指令")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("保存") { onSave(template); dismiss() }.disabled(template.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || template.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || template.title.count > 60 || template.text.count > 10_000) }
            }
        }.frame(minWidth: 300, minHeight: 340)
    }
}

public struct ExperienceDiagnosticsView: View {
    @ObservedObject private var metrics = ExperienceMetrics.shared
    @State private var clearing = false
    @Environment(\.dismiss) private var dismiss
    public init() {}
    public var body: some View {
        NavigationStack {
            Form {
                Section("本机最近 7 天") {
                    Text("只在这台设备聚合，不上传正文、路径、任务标识或设备名称。耗时分位数取每日最近最多 256 次测量，不代表真机体验承诺。").font(.callout).foregroundStyle(.secondary)
                    ForEach(metrics.summaries) { item in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(Self.labels[item.id] ?? item.id).font(.headline)
                            Text("\(item.count) 次").font(.callout)
                            if let p95 = item.p95Milliseconds { Text("p50 \(Int(item.p50Milliseconds ?? 0))ms · p95 \(Int(p95))ms").font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                }
                Section("导出预览") { Text(metrics.export()).font(.system(.caption, design: .monospaced)).textSelection(.enabled); ShareLink("导出本机统计", item: metrics.export()) }
                Section { Button("清除本机统计", role: .destructive) { clearing = true } }
            }
            .formStyle(.grouped)
            .navigationTitle("使用与性能")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
            .confirmationDialog("清除本机统计？", isPresented: $clearing) { Button("清除", role: .destructive) { metrics.clear() } }
        }.frame(minWidth: 300, minHeight: 420)
    }
    private static let labels = ["firstSnapshot":"首次同步", "snapshotRefresh":"同步刷新", "commandSaved":"操作已保存", "commandReceived":"设备已确认", "commandFailed":"操作失败", "approvalReceived":"审批已确认", "artifactOpened":"成果打开"]
}
