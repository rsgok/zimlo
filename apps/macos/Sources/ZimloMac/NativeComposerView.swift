import SwiftUI
import UniformTypeIdentifiers

struct NativeComposerContext: Identifiable, Equatable {
    let id = UUID()
    var projectID: String?
    var sessionID: String?
}

struct NativeComposerOverlay: View {
    let context: NativeComposerContext
    @ObservedObject var store: NativeAppStore
    let onDismiss: () -> Void

    @StateObject private var speech = NativeSpeechRecognizer()
    @State private var text = ""
    @State private var workspaceID = ""
    @State private var provider: Provider = .codex
    @State private var materials: [Material] = []
    @State private var choosingFiles = false
    @State private var sending = false
    @State private var dictationPrefix = ""
    @FocusState private var inputFocused: Bool

    private var session: AgentSession? {
        context.sessionID.flatMap { id in store.snapshot.sessions.first { $0.id == id } }
    }
    private var project: Project? {
        let id = context.projectID ?? session?.projectId
        return id.flatMap { projectID in store.snapshot.projects.first { $0.id == projectID } }
    }
    private var selectedWorkspace: TrustedWorkspace? {
        store.snapshot.workspaces.first { $0.id == workspaceID }
    }
    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !sending
            && (session != nil || (!workspaceID.isEmpty && selectedWorkspace?.providers.contains(provider) == true))
    }

    var body: some View {
        ZStack {
            Color.black.opacity(0.52)
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture(perform: onDismiss)

            VStack(spacing: 0) {
                header
                Divider().overlay(NativeTheme.border)
                VStack(spacing: 15) {
                    if session == nil { destinationPicker }
                    if !materials.isEmpty { attachmentList }
                    inputRow
                    Text("可拖入图片、视频、PDF 或文档 · 草稿会自动保留")
                        .font(.system(size: 9.5, weight: .medium))
                        .foregroundStyle(NativeTheme.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(18)
            }
            .frame(width: 650)
            .background(NativeTheme.surface)
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(NativeTheme.border, lineWidth: 1))
            .shadow(color: .black.opacity(0.42), radius: 34, y: 16)
            .contentShape(Rectangle())
            .onTapGesture { }
            .dropDestination(for: URL.self) { urls, _ in
                Task { materials.append(contentsOf: await store.importFiles(urls)) }
                return true
            }
        }
        .onExitCommand(perform: onDismiss)
        .fileImporter(
            isPresented: $choosingFiles,
            allowedContentTypes: [.image, .movie, .pdf, .text, .spreadsheet, .presentation, .data],
            allowsMultipleSelection: true
        ) { result in
            guard case .success(let urls) = result else { return }
            Task { materials.append(contentsOf: await store.importFiles(urls)) }
        }
        .task {
            restoreDefaults()
            inputFocused = true
        }
        .onChange(of: text) { _, value in UserDefaults.standard.set(value, forKey: draftKey) }
        .onChange(of: speech.transcript) { _, transcript in
            guard !transcript.isEmpty else { return }
            text = [dictationPrefix, transcript].filter { !$0.isEmpty }.joined(separator: dictationPrefix.isEmpty ? "" : " ")
        }
        .onChange(of: speech.state) { _, state in
            if case .failed(let message) = state { store.showNotice(message, tone: .failure) }
        }
        .onDisappear { speech.stop() }
    }

    private var header: some View {
        HStack(spacing: 12) {
            NativeAgentAvatar(avatar: project?.agentProfile.avatar ?? "●", size: 38)
            VStack(alignment: .leading, spacing: 2) {
                Text(session == nil ? "新任务" : "回复 Agent")
                    .font(.system(size: 17, weight: .bold, design: .rounded))
                Text(session?.title ?? project?.agentProfile.displayName ?? "把清晰目标交给 Agent")
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(NativeTheme.muted)
                    .lineLimit(1)
            }
            Spacer()
            Text("点空白处或 Esc 收起")
                .font(.system(size: 9.5, weight: .medium))
                .foregroundStyle(NativeTheme.muted)
        }
        .padding(.horizontal, 18)
        .frame(height: 68)
    }

    private var destinationPicker: some View {
        HStack(spacing: 10) {
            Picker("交给", selection: $workspaceID) {
                if store.snapshot.workspaces.isEmpty { Text("暂无可信项目").tag("") }
                ForEach(store.snapshot.workspaces.sorted { $0.lastUsedAt > $1.lastUsedAt }) { workspace in
                    Text(agentName(for: workspace)).tag(workspace.id)
                }
            }
            .labelsHidden()
            .frame(maxWidth: .infinity)
            .onChange(of: workspaceID) { _, _ in coerceProvider() }

            Picker("Runtime", selection: $provider) {
                ForEach(Provider.allCases) { item in Text(item.label).tag(item) }
            }
            .labelsHidden()
            .frame(width: 150)
        }
    }

    private var inputRow: some View {
        HStack(spacing: 8) {
            Button {
                choosingFiles = true
            } label: {
                Image(systemName: "paperclip")
                    .font(.system(size: 13, weight: .bold))
                    .frame(width: 34, height: 34)
            }
            .buttonStyle(NativeComposerIconButtonStyle(active: false))
            .disabled(materials.count >= 10 || store.importingFiles)
            .help("添加附件")

            TextField(session == nil ? "描述目标，或点麦克风说出任务…" : "输入回复…", text: $text)
                .textFieldStyle(.plain)
                .font(.system(size: 13, weight: .medium))
                .focused($inputFocused)
                .onSubmit(submit)
                .padding(.horizontal, 12)
                .frame(height: 36)
                .background(NativeTheme.raised)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(inputFocused ? NativeTheme.acid.opacity(0.42) : NativeTheme.border, lineWidth: 1))

            Button {
                dictationPrefix = text.trimmingCharacters(in: .whitespacesAndNewlines)
                Task { await speech.toggle() }
            } label: {
                Image(systemName: speech.isListening ? "waveform" : "mic.fill")
                    .font(.system(size: 13, weight: .bold))
                    .symbolEffect(.variableColor.iterative, isActive: speech.isListening)
                    .frame(width: 34, height: 34)
            }
            .buttonStyle(NativeComposerIconButtonStyle(active: speech.isListening))
            .help(speech.isListening ? "停止听写" : "语音输入")

            Button(action: submit) {
                Group {
                    if sending { ProgressView().controlSize(.small) }
                    else { Image(systemName: "arrow.up").font(.system(size: 13, weight: .black)) }
                }
                .frame(width: 34, height: 34)
            }
            .buttonStyle(NativeSendButtonStyle(enabled: canSend))
            .disabled(!canSend)
            .keyboardShortcut(.return, modifiers: .command)
            .help(session == nil ? "开始任务" : "发送回复")
        }
    }

    private var attachmentList: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(materials) { material in
                    HStack(spacing: 7) {
                        Image(systemName: materialSymbol(material.kind)).foregroundStyle(NativeTheme.acid)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(material.name).font(.system(size: 9.5, weight: .semibold)).lineLimit(1)
                            Text(ByteCountFormatter.string(fromByteCount: Int64(material.sizeBytes), countStyle: .file))
                                .font(.system(size: 8.5, weight: .medium)).foregroundStyle(NativeTheme.muted)
                        }
                        Button { materials.removeAll { $0.id == material.id } } label: {
                            Image(systemName: "xmark.circle.fill").foregroundStyle(NativeTheme.muted)
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.horizontal, 9)
                    .frame(height: 40)
                    .background(NativeTheme.raised)
                    .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                }
            }
        }
        .scrollIndicators(.hidden)
    }

    private func submit() {
        guard canSend else { return }
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let ids = materials.map(\.id)
        sending = true
        speech.stop()
        Task {
            let sent: Bool
            if let session { sent = await store.followUp(sessionID: session.id, text: value, materialIDs: ids) }
            else { sent = await store.createTask(text: value, provider: provider, workspaceID: workspaceID, materialIDs: ids) }
            sending = false
            guard sent else { return }
            UserDefaults.standard.removeObject(forKey: draftKey)
            if session == nil {
                UserDefaults.standard.set(workspaceID, forKey: "zimlo.mac.last-workspace")
                UserDefaults.standard.set(provider.rawValue, forKey: "zimlo.mac.last-provider")
            }
            onDismiss()
        }
    }

    private func restoreDefaults() {
        text = UserDefaults.standard.string(forKey: draftKey) ?? ""
        guard session == nil else { return }
        let preferredWorkspace = project.flatMap { project in
            store.snapshot.workspaces.first { project.paths.contains($0.path) }
        }
        let savedID = UserDefaults.standard.string(forKey: "zimlo.mac.last-workspace")
        workspaceID = preferredWorkspace?.id
            ?? store.snapshot.workspaces.first(where: { $0.id == savedID })?.id
            ?? store.snapshot.workspaces.sorted { $0.lastUsedAt > $1.lastUsedAt }.first?.id
            ?? ""
        if let value = project?.agentProfile.defaultProvider
            ?? UserDefaults.standard.string(forKey: "zimlo.mac.last-provider").flatMap(Provider.init(rawValue:)) {
            provider = value
        }
        coerceProvider()
    }

    private func coerceProvider() {
        guard let workspace = selectedWorkspace else { return }
        if !workspace.providers.contains(provider), let first = workspace.providers.first { provider = first }
    }

    private func agentName(for workspace: TrustedWorkspace) -> String {
        store.snapshot.projects.first(where: { $0.paths.contains(workspace.path) })?.agentProfile.displayName ?? workspace.label
    }

    private var draftKey: String { context.sessionID.map { "zimlo.mac.reply-draft.\($0)" } ?? "zimlo.mac.new-task-draft" }

    private func materialSymbol(_ kind: String) -> String {
        ["image": "photo", "video": "play.rectangle.fill", "pdf": "doc.richtext", "document": "doc" ][kind] ?? "paperclip"
    }
}

private struct NativeComposerIconButtonStyle: ButtonStyle {
    let active: Bool
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(active ? NativeTheme.paper : NativeTheme.ink)
            .background(active ? NativeTheme.coral : NativeTheme.raised)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(active ? NativeTheme.coral : NativeTheme.border, lineWidth: 1))
            .opacity(configuration.isPressed ? 0.72 : 1)
    }
}

private struct NativeSendButtonStyle: ButtonStyle {
    let enabled: Bool
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(NativeTheme.paper.opacity(enabled ? 1 : 0.42))
            .background(NativeTheme.acid.opacity(enabled ? 1 : 0.28))
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .shadow(color: enabled ? NativeTheme.acid.opacity(0.22) : .clear, radius: 7)
            .opacity(configuration.isPressed ? 0.72 : 1)
    }
}
