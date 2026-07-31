import SwiftUI

// Outbox 详情：每条排队指令的类型、目标、内容预览、创建时间与状态。
// 仅 queued 的 create/follow-up 可撤回（走 task.command.cancel）；
// 审批、设备、设置类指令只展示，不提供撤回。
struct OutboxView: View {
    @ObservedObject var model: AppModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if model.outboxEntries.isEmpty {
                    VStack(spacing: 10) {
                        Image(systemName: "checkmark.circle").font(.largeTitle).foregroundStyle(ZColor.sage)
                        Text("没有待同步操作").font(ZFont.title3)
                        Text("离线时的回复、审批和设置变更会先保存在这里，连接 Mac 后自动发送。")
                            .font(ZFont.footnote).foregroundStyle(ZColor.muted)
                            .multilineTextAlignment(.center)
                    }
                    .padding(30)
                } else {
                    List {
                        ForEach(model.outboxEntries) { entry in
                            OutboxRow(model: model, entry: entry)
                        }
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                }
            }
            .background(ZColor.paper)
            .foregroundStyle(ZColor.ink)
            .navigationTitle("待同步操作")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }.foregroundStyle(ZColor.ink)
                }
            }
        }
    }
}

private struct OutboxRow: View {
    @ObservedObject var model: AppModel
    let entry: OutboxEntry

    private var stateLabel: String {
        if entry.lastError != nil { return "发送失败" }
        return model.bridge.connected ? "等待 Mac 确认" : "排队中（离线）"
    }

    private var stateColor: Color {
        if entry.lastError != nil { return ZColor.coral }
        return model.bridge.connected ? ZColor.sage : ZColor.muted
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(typeLabel).font(ZFont.headline)
                Spacer()
                Text(stateLabel).font(ZFont.caption2).foregroundStyle(stateColor)
            }
            if let target { Text(target).font(ZFont.footnote).foregroundStyle(ZColor.muted).lineLimit(1) }
            if let preview {
                Text(preview)
                    .font(ZFont.callout)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            TimelineView(.periodic(from: .now, by: 30)) { _ in
                Text("创建于 \(relative(entry.enqueuedAt))").font(ZFont.caption2).foregroundStyle(ZColor.muted)
            }
            if let error = entry.lastError {
                Text(error).font(ZFont.caption).foregroundStyle(ZColor.coral).lineLimit(2)
            }
            HStack(spacing: 14) {
                if entry.lastError != nil {
                    Button("重试") { model.retryOutboxEntry(entry) }
                        .font(ZFont.caption).foregroundStyle(ZColor.sage)
                    if canReedit {
                        Button("重新编辑") { _ = model.reeditOutboxEntry(entry) }
                            .font(ZFont.caption).foregroundStyle(ZColor.sage)
                    }
                    if !canReedit {
                        Button("移除", role: .destructive) { model.removeOutboxEntry(entry) }
                            .font(ZFont.caption)
                    }
                }
                if CommandCancelRules.isOutboxEntryCancelable(entry, snapshot: model.snapshot) {
                    Button("撤回", role: .destructive) { _ = model.cancelOutboxEntry(entry) }
                        .font(ZFont.caption)
                }
            }
        }
        .padding(.vertical, 6)
    }

    private var canReedit: Bool {
        ["task.create", "task.follow_up", "session.message"].contains(entry.command.type)
    }

    private var typeLabel: String {
        switch entry.command.type {
        case "task.create": return "新任务"
        case "task.follow_up", "session.message": return "追加指令"
        case "action.decide": return "审批决定"
        case "review.respond": return "结果审阅"
        case "task.command.retry": return "重试指令"
        case "task.command.cancel": return "撤回指令"
        case "feed.dismiss", "feed.dismiss.set": return "Feed 移除"
        case "feed.seen": return "已读标记"
        case "task.timeline.seen": return "时间线已读"
        case "task.pin": return "置顶变更"
        case "task.archive": return "归档变更"
        case "user.profile.update": return "头像设置"
        case "agent.profile.update": return "Agent 资料"
        case "trust.policy.update": return "自动化权限"
        case "notification.settings.update": return "通知设置"
        case "notification.device.register", "notification.device.unregister": return "推送设备注册"
        default: return entry.command.type
        }
    }

    private var target: String? {
        func string(_ key: String) -> String? {
            guard case .string(let value) = entry.command.values[key], !value.isEmpty else { return nil }
            return value
        }
        if let sessionId = string("sessionId"),
           let session = model.snapshot.sessions.first(where: { $0.id == sessionId }) {
            return "任务：\(session.title)"
        }
        if let projectId = string("projectId"),
           let project = model.snapshot.projects.first(where: { $0.id == projectId }) {
            return "项目：\(project.name)"
        }
        if let workspaceId = string("workspaceId"),
           let workspace = model.snapshot.workspaces.first(where: { $0.id == workspaceId }) {
            return "工作区：\(workspace.label)"
        }
        return string("itemId") ?? string("postId")
    }

    private var preview: String? {
        func string(_ key: String) -> String? {
            guard case .string(let value) = entry.command.values[key], !value.isEmpty else { return nil }
            return value
        }
        if let text = string("text") { return text }
        if let note = string("note") { return note }
        if let decision = string("decisionId") { return "决定：\(decision)" }
        if case .object(let input) = entry.command.values["input"],
           case .string(let answer) = input["answer"] {
            return "回答：\(answer)"
        }
        return nil
    }
}
