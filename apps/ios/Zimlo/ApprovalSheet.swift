import SwiftUI

// 双确认状态机 HighRiskApprovalState 在 SharedRules.swift（不依赖 SwiftUI，可被
// XCTest 与命令行 harness 直接驱动）。本文件只保留 Sheet 视图。

struct ApprovalExpiry: Equatable {
    let deadline: Date

    func isExpired(at date: Date) -> Bool {
        date >= deadline
    }

    func remainingSeconds(at date: Date) -> Int {
        max(0, Int(ceil(deadline.timeIntervalSince(date))))
    }

    func label(at date: Date) -> String {
        let seconds = remainingSeconds(at: date)
        guard seconds > 0 else { return "审批已失效" }
        if seconds >= 60 {
            return "\(seconds / 60) 分 \(seconds % 60) 秒后失效"
        }
        return "\(seconds) 秒后失效"
    }
}

struct HighRiskApprovalSheet: View {
    let action: PendingAction
    let decision: Decision
    let onSubmit: () -> Void
    let onCancel: () -> Void
    @State private var state: HighRiskApprovalState
    @State private var didExpire = false

    init(action: PendingAction, decision: Decision, onSubmit: @escaping () -> Void, onCancel: @escaping () -> Void) {
        self.action = action
        self.decision = decision
        self.onSubmit = onSubmit
        self.onCancel = onCancel
        _state = State(initialValue: HighRiskApprovalState(requiredPhrase: decision.confirmationPhrase ?? ""))
    }

    private var expiry: ApprovalExpiry { ApprovalExpiry(deadline: action.expiresAt.zimloDate) }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            content(at: context.date)
        }
        .task(id: action.expiresAt) { await expireAtDeadline() }
    }

    private func content(at now: Date) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Label("高风险操作", systemImage: "exclamationmark.triangle.fill")
                    .font(ZFont.caption)
                    .foregroundStyle(ZColor.ink)
                Spacer()
                Button("取消") {
                    state.reset()
                    onCancel()
                }
                .font(ZFont.headline)
                .frame(minWidth: 44, minHeight: 44)
            }
            .padding(.bottom, 10)

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(action.title).font(ZFont.title2).fixedSize(horizontal: false, vertical: true)
                    if !action.detail.isEmpty {
                        Text(action.detail).font(ZFont.body).foregroundStyle(ZColor.ink.opacity(0.72))
                    }

                    HStack(spacing: 8) {
                        Image(systemName: expiry.isExpired(at: now) ? "exclamationmark.circle.fill" : "clock.fill")
                            .foregroundStyle(ZColor.coral)
                        Text(expiry.label(at: now))
                            .font(ZFont.footnote.weight(.bold))
                            .monospacedDigit()
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 10)
                    .foregroundStyle(ZColor.ink)
                    .background(ZColor.coral.opacity(0.11))
                    .clipShape(RoundedRectangle(cornerRadius: ZRadius.small, style: .continuous))
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(expiry.label(at: now))

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
                    .background(ZColor.raised)
                    .clipShape(RoundedRectangle(cornerRadius: ZRadius.inner, style: .continuous))

                    VStack(alignment: .leading, spacing: 8) {
                        Text("确认短语").font(ZFont.caption2).foregroundStyle(ZColor.muted)
                        Text(state.requiredPhrase)
                            .font(ZFont.headline)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                        if state.phase == .needsFill {
                            Button("填入确认短语") { state.fillPhrase() }
                                .buttonStyle(RiskAcknowledgeButtonStyle())
                                .accessibilityHint("完成第一步确认；仍需再次点击确认执行")
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
                guard !expiry.isExpired(at: Date()) else {
                    expire()
                    return
                }
                guard state.submit() != nil else { return }
                onSubmit()
            }
            .buttonStyle(DangerApprovalButtonStyle())
            .disabled(!state.canSubmit || expiry.isExpired(at: now))
            .accessibilityHint("提交后将立即执行高风险操作")
            .padding(.top, 12)
        }
        .padding(20)
        .foregroundStyle(ZColor.ink)
        .background(ZColor.paper)
        .onAppear { Haptics.highRiskPrompt() }
    }

    private func expireAtDeadline() async {
        let delay = expiry.deadline.timeIntervalSinceNow
        if delay > 0 {
            do { try await Task.sleep(for: .seconds(delay)) }
            catch { return }
        }
        guard !Task.isCancelled else { return }
        expire()
    }

    private func expire() {
        guard !didExpire else { return }
        didExpire = true
        state.reset()
        onCancel()
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

private struct RiskAcknowledgeButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(ZFont.callout.weight(.black))
            .frame(maxWidth: .infinity, minHeight: 44)
            .padding(.horizontal, 14).padding(.vertical, 4)
            .foregroundStyle(ZColor.ink.opacity(isEnabled ? 1 : 0.48))
            .background(ZColor.coral.opacity(isEnabled ? 0.12 : 0.05))
            .overlay(RoundedRectangle(cornerRadius: ZRadius.control, style: .continuous)
                .stroke(ZColor.coral.opacity(isEnabled ? 1 : 0.35)))
            .clipShape(RoundedRectangle(cornerRadius: ZRadius.control, style: .continuous))
            .opacity(configuration.isPressed ? 0.72 : 1)
    }
}

private struct DangerApprovalButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(ZFont.callout.weight(.black))
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, minHeight: 44)
            .padding(.horizontal, 14).padding(.vertical, 5)
            .foregroundStyle(ZColor.ink.opacity(isEnabled ? 1 : 0.48))
            .background(isEnabled ? ZColor.coral : ZColor.control)
            .clipShape(RoundedRectangle(cornerRadius: ZRadius.control, style: .continuous))
            .opacity(configuration.isPressed ? 0.72 : 1)
    }
}
