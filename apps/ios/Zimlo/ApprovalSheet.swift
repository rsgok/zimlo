import SwiftUI

// 双确认状态机 HighRiskApprovalState 在 SharedRules.swift（不依赖 SwiftUI，可被
// XCTest 与命令行 harness 直接驱动）。本文件只保留 Sheet 视图。

struct HighRiskApprovalSheet: View {
    let action: PendingAction
    let decision: Decision
    let onSubmit: () -> Void
    let onCancel: () -> Void
    @State private var state: HighRiskApprovalState

    init(action: PendingAction, decision: Decision, onSubmit: @escaping () -> Void, onCancel: @escaping () -> Void) {
        self.action = action
        self.decision = decision
        self.onSubmit = onSubmit
        self.onCancel = onCancel
        _state = State(initialValue: HighRiskApprovalState(requiredPhrase: decision.confirmationPhrase ?? ""))
    }

    private var expired: Bool { action.expiresAt.zimloDate < Date() }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("高风险操作").font(ZFont.caption).foregroundStyle(ZColor.coral)
                Spacer()
                Button("取消") {
                    state.reset()
                    onCancel()
                }
                .font(ZFont.headline)
            }
            .padding(.bottom, 14)

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(action.title).font(ZFont.title2).fixedSize(horizontal: false, vertical: true)
                    if !action.detail.isEmpty {
                        Text(action.detail).font(ZFont.body).foregroundStyle(ZColor.ink.opacity(0.72))
                    }

                    VStack(alignment: .leading, spacing: 10) {
                        fact("风险等级", "高风险 · \(scopeLabel)")
                        if let context = action.approvalContext {
                            fact("类别", context.category)
                            if let command = context.command, !command.isEmpty {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("目标命令").font(ZFont.caption2).foregroundStyle(ZColor.muted)
                                    Text(command)
                                        .font(.footnote.monospaced().weight(.semibold))
                                        .fixedSize(horizontal: false, vertical: true)
                                        .textSelection(.enabled)
                                }
                            }
                            if !context.segments.isEmpty {
                                fact("涉及路径", context.segments.joined(separator: "\n"))
                            }
                            if let cwd = context.cwd, !cwd.isEmpty {
                                fact("工作目录", cwd)
                            }
                            if !context.reason.isEmpty {
                                fact("原因", context.reason)
                            }
                        }
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.white.opacity(0.6))
                    .clipShape(RoundedRectangle(cornerRadius: ZRadius.inner, style: .continuous))

                    VStack(alignment: .leading, spacing: 8) {
                        Text("确认短语").font(ZFont.caption2).foregroundStyle(ZColor.muted)
                        Text(state.requiredPhrase)
                            .font(ZFont.headline)
                            .textSelection(.enabled)
                        if state.phase == .needsFill {
                            Button("填入确认短语") { state.fillPhrase() }
                                .buttonStyle(ActionButtonStyle(primary: false))
                        } else {
                            HStack(spacing: 8) {
                                Image(systemName: "checkmark.circle.fill").foregroundStyle(ZColor.sage)
                                Text("已填入，请再次确认后提交").font(ZFont.callout)
                            }
                        }
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(ZColor.coral.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: ZRadius.inner, style: .continuous))
                }
            }
            .scrollIndicators(.hidden)

            Button("确认执行「\(decision.label)」") {
                guard state.submit() != nil else { return }
                onSubmit()
            }
            .buttonStyle(ActionButtonStyle(primary: true))
            .tint(ZColor.coral)
            .disabled(!state.canSubmit)
            .padding(.top, 12)
        }
        .padding(20)
        .foregroundStyle(ZColor.ink)
        .background(ZColor.paper)
        .onAppear { Haptics.highRiskPrompt() }
        .onChange(of: expired) { _, isExpired in
            if isExpired {
                state.reset()
                onCancel()
            }
        }
    }

    private var scopeLabel: String {
        ["once": "仅此一次", "session": "整个任务", "persistent": "长期有效", "deny": "拒绝"][decision.scope] ?? decision.scope
    }

    private func fact(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(ZFont.caption2).foregroundStyle(ZColor.muted)
            Text(value).font(ZFont.callout).fixedSize(horizontal: false, vertical: true)
        }
    }
}
