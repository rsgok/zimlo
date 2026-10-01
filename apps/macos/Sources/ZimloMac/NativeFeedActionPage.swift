import SwiftUI

struct NativeFeedActionPage: View {
    @ObservedObject var store: NativeAppStore
    let action: PendingAction

    private var active: Bool {
        store.snapshot.actions.contains { $0.id == action.id && $0.state == "pending" && $0.expiresAt.zimloDate > Date() }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            Text(store.snapshot.host?.name ?? "运行设备")
                .font(.subheadline).foregroundStyle(NativeTheme.muted)
            if active {
                NativeActionCard(store: store, action: action)
            } else {
                Label("这项操作已处理或已过期", systemImage: "checkmark.circle")
                    .font(.title2)
                Text(action.title).font(.headline)
            }
            NavigationLink(value: NativeRoute.task(action.sessionId)) {
                Label("查看所属任务", systemImage: "arrow.right")
            }
        }
        .padding(28).frame(maxWidth: .infinity, alignment: .leading)
        .nativeCard(cornerRadius: 19)
    }
}

struct NativeFeedCommandPage: View {
    @ObservedObject var store: NativeAppStore
    let command: TaskCommand
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Label(command.state == "failed" ? "任务未能开始" : command.id.hasPrefix("local:") ? "已保存，等待设备确认" : "任务已交给运行设备",
                  systemImage: command.state == "failed" ? "exclamationmark.triangle" : "clock")
                .font(.title2.bold())
            Text(command.text).font(.body)
            Text(command.error ?? TaskPresentationRules.stateLabel(command.state))
                .foregroundStyle(NativeTheme.muted)
            if let session = command.sessionId {
                NavigationLink("查看任务", value: NativeRoute.task(session))
            } else if command.state == "failed", !command.id.hasPrefix("local:") {
                Button("重试任务") {
                    Task {
                        _ = await store.send(ClientCommand(type: "task.command.retry", [
                            "commandId": .string(command.id), "idempotencyKey": .string(UUID().uuidString),
                        ]))
                    }
                }.buttonStyle(.borderedProminent)
            }
        }
        .padding(28).frame(maxWidth: .infinity, alignment: .leading)
        .nativeCard(cornerRadius: 19)
    }
}
