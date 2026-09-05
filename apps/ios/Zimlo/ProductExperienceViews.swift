import SwiftUI
import QuickLook
import ZimloCore

struct MobileSetupChecklist: View {
    @ObservedObject var model: AppModel
    let pair: () -> Void
    var body: some View {
        SetupChecklistView(steps: SetupChecklist.steps(connected: model.bridge.hosts.contains { $0.connected },
            agentReady: !model.snapshot.workspaces.isEmpty || !model.snapshot.sessions.isEmpty,
            hasProject: !model.snapshot.projects.isEmpty, paired: !model.bridge.hosts.isEmpty,
            hasReceipt: ExperienceMetrics.shared.hasConfirmedOperation)) { step in
                if step == "phone" || step == "connection" { pair() }
                else if step == "receipt" { model.showingNewTask = true }
                else { model.showNotice("请在运行设备上接入 Codex 或 Claude Code，并在一个项目中开始任务。") }
            }.padding(16).background(ZColor.raised).clipShape(RoundedRectangle(cornerRadius: 16))
    }
}

struct MobileHistoryView: View {
    @ObservedObject var model: AppModel
    @State private var selectedHost = ""
    @State private var previewURL: URL?
    @State private var previewError: String?
    private var hostId: String { selectedHost.isEmpty ? (model.bridge.hosts.first(where: { $0.connected })?.id ?? model.bridge.hosts.first?.id ?? "") : selectedHost }
    var body: some View {
        VStack(spacing: 0) {
            if model.bridge.hosts.count > 1 {
                Picker("运行设备", selection: Binding(get: { hostId }, set: { selectedHost = $0 })) {
                    ForEach(model.bridge.hosts) { Text($0.host.name).tag($0.id) }
                }.pickerStyle(.menu).padding(.horizontal)
            }
            HistorySearchView(projects: model.snapshot.projects.filter { $0.hostId == hostId }.map { HistoryProject(id: $0.id, name: $0.name) }, sourceName: model.bridge.hosts.first(where: { $0.id == hostId })?.host.name ?? "", search: { query in
                let target = hostId
                return try await model.history.request(query, hostId: target) { request in
                    var values: [String: JSONValue] = ["hostId": .string(target), "requestId": .string(request.requestId), "query": .string(request.query), "kind": .string(request.kind)]
                    for (key, value) in [("projectId", request.projectId), ("after", request.after), ("cursor", request.cursor)] { if let value { values[key] = .string(value) } }
                    return model.bridge.send(ClientCommand(type: "history.search", values))
                }
            }) { entry in
                if let id = entry.sessionId { model.openTask(sessionId: id) }
            } openMaterial: { value in
                Task {
                    do {
                        let material = try JSONDecoder().decode(Material.self, from: JSONEncoder().encode(value))
                        previewURL = try await model.localURL(for: material)
                        ExperienceMetrics.shared.record(.artifactOpened)
                    } catch { previewError = error.localizedDescription }
                }
            }.id(hostId)
        }
        .quickLookPreview($previewURL)
        .alert("文件暂不可用", isPresented: Binding(get: { previewError != nil }, set: { if !$0 { previewError = nil } })) { Button("知道了") { previewError = nil } } message: { Text(previewError ?? "") }
    }
}
