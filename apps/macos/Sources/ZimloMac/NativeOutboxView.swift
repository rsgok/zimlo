import SwiftUI

struct NativeOutboxView: View {
    @ObservedObject var store: NativeAppStore
    let onEdit: (NativeOutboxEntry) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text("发送队列").font(.title2.bold())
                Spacer()
                Button("完成") { dismiss() }
            }
            if let issue = store.outbox.storageIssue {
                Label(issue, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(NativeTheme.coral)
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    if store.outbox.entries.isEmpty {
                        Text("没有等待确认的本机操作。").foregroundStyle(NativeTheme.muted)
                    }
                    ForEach(store.outbox.entries) { entry in
                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                Text(entry.command.type == "task.create" ? "新任务" : "回复任务").bold()
                                Spacer()
                                Text(entry.createdAt, style: .time).foregroundStyle(NativeTheme.muted)
                            }
                            Text(entry.preview).lineLimit(5)
                            Text(entry.stateLabel).foregroundStyle(entry.state == .failed ? NativeTheme.coral : NativeTheme.muted)
                            if entry.hostID != store.snapshot.host?.id {
                                Text("等待连接原来的运行设备，操作不会发送到其他设备。")
                                    .foregroundStyle(NativeTheme.coral)
                            }
                            if let error = entry.error { Text(error).font(.callout).foregroundStyle(NativeTheme.muted) }
                            HStack {
                                Button(entry.state == .failed ? "重试" : "立即重新确认") {
                                    store.outbox.retry(entry.id)
                                    Task { await store.flushOutbox() }
                                }.disabled(entry.hostID != store.snapshot.host?.id)
                                if entry.canWithdrawLocally {
                                    Button("撤回") { _ = store.outbox.withdraw(entry.id) }
                                }
                                if entry.state == .failed {
                                    Button("重新编辑") { onEdit(entry) }
                                        .disabled(entry.hostID != store.snapshot.host?.id)
                                    Button("移除记录") { _ = store.outbox.discardFailure(entry.id) }
                                }
                            }
                        }.padding(16).nativeCard()
                    }
                    ForEach(store.snapshot.commands.filter { $0.state == "queued" }) { command in
                        VStack(alignment: .leading, spacing: 10) {
                            Text("设备已收到，等待 Agent 开始").bold()
                            Text(command.text).lineLimit(4)
                            Button("撤回") { Task { await store.cancelQueuedCommand(command) } }
                        }.padding(16).nativeCard()
                    }
                }
            }
        }
        .padding(24).frame(width: 580, height: 560)
        .background(NativeTheme.paper)
    }
}
