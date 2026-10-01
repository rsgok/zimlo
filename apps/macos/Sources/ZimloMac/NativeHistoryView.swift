import SwiftUI
import ZimloCore

struct NativeHistoryView: View {
    @ObservedObject var store: NativeAppStore
    var body: some View {
        HistorySearchView(projects: store.snapshot.projects.map { HistoryProject(id: $0.id, name: $0.name) }, sourceName: store.snapshot.host?.name ?? "", search: store.searchHistory) { entry in
            if let id = entry.sessionId { NotificationCenter.default.post(name: .zimloOpenTask, object: id) }
        } openMaterial: { value in
            guard let data = try? JSONEncoder().encode(value), let material = try? JSONDecoder().decode(Material.self, from: data) else { return }
            store.openMaterial(material)
        }.frame(width: 700, height: 650)
    }
}
