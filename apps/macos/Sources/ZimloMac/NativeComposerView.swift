import SwiftUI
import ZimloCore
import UniformTypeIdentifiers

struct NativeComposerContext: Identifiable, Equatable {
    let id = UUID()
    var projectID: String?
    var sessionID: String?
    var editingEntry: NativeOutboxEntry?
}

struct NativeComposerOverlay: View {
    let context: NativeComposerContext
    @ObservedObject var store: NativeAppStore
    let onDismiss: () -> Void
    var onSetup: () -> Void = {}

    @StateObject private var speech = NativeSpeechRecognizer()
    @State private var text = ""
    @State private var showingTemplates = false
    @State private var workspaceID = ""
    @State private var provider: Provider = .codex
    @State private var materials: [Material] = []
    @State private var choosingFiles = false
    @State private var sending = false
    @State private var dictationPrefix = ""
    @State private var draftHostID: String?
    @State private var restored = false
    @State private var unresolvedMaterialIDs: [String] = []
    @FocusState private var inputFocused: Bool

    private var session: AgentSession? {
        context.sessionID.flatMap { id in store.snapshot.sessions.first { $0.id == id } }
    }
    private var project: Project? {
        if let projectID = context.projectID,
           let project = store.snapshot.projects.first(where: { $0.id == projectID }) {
            return project
        }
        if let session { return store.snapshot.project(for: session) }
        guard let workspace = selectedWorkspace else { return nil }
        return store.snapshot.projects.first { project in
            project.paths.contains { path in workspace.path == path || workspace.path.hasPrefix(path + "/") }
        }
    }
    private var selectedWorkspace: TrustedWorkspace? {
        store.snapshot.workspaces.first { $0.id == workspaceID }
    }
    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !sending && !store.importingFiles && unresolvedMaterialIDs.isEmpty
            && (draftHostID == nil || draftHostID == store.snapshot.host?.id)
            && (session != nil || (!workspaceID.isEmpty && selectedWorkspace?.providers.contains(provider) == true))
    }

    var body: some View {
        ZStack {
            Color.black.opacity(0.52)
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture(perform: dismissComposer)

            VStack(spacing: 0) {
                header
                Divider().overlay(NativeTheme.border)
                VStack(spacing: 15) {
                    if session == nil {
                        if store.snapshot.workspaces.isEmpty { setupPrompt }
                        else { destinationPicker }
                    }
                    if let draftHostID, draftHostID != store.snapshot.host?.id {
                        Text("这份草稿属于另一台运行设备，连接原设备后可以继续发送。")
                            .foregroundStyle(NativeTheme.coral)
                    }
                    if !unresolvedMaterialIDs.isEmpty {
                        Text("有 \(unresolvedMaterialIDs.count) 个附件暂不可用，确认后才能重新发送。")
                            .foregroundStyle(NativeTheme.coral)
                        Button("移除不可用附件") { unresolvedMaterialIDs = []; saveDraft() }
                    }
                    if !materials.isEmpty { attachmentList }
                    Button("常用指令", systemImage: "text.badge.plus") { showingTemplates = true }.frame(maxWidth: .infinity, alignment: .leading)
                    inputRow
                    Text("可拖入图片、视频、PDF 或文档 · 草稿会自动保留")
                        .font(.callout)
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
        .sheet(isPresented: $showingTemplates) { PromptTemplateLibrary { template in text = text.isEmpty ? template.text : text + "\n\n" + template.text }.frame(width: 520, height: 500) }
        .onExitCommand(perform: dismissComposer)
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
        .onChange(of: text) { _, _ in saveDraft() }
        .onChange(of: materials) { _, _ in saveDraft() }
        .onChange(of: store.snapshot.workspaces) { _, workspaces in
            guard session == nil, !workspaces.contains(where: { $0.id == workspaceID }) else { return }
            workspaceID = workspaces.sorted { $0.lastUsedAt > $1.lastUsedAt }.first?.id ?? ""
            coerceProvider()
        }
        .onChange(of: workspaceID) { _, _ in saveDraft() }
        .onChange(of: provider) { _, _ in saveDraft() }
        .onChange(of: speech.transcript) { _, transcript in
            guard !transcript.isEmpty else { return }
            text = [dictationPrefix, transcript].filter { !$0.isEmpty }.joined(separator: dictationPrefix.isEmpty ? "" : " ")
        }
        .onChange(of: speech.state) { _, state in
            if case .failed(let message) = state { store.showNotice(message, tone: .failure) }
        }
        .onDisappear { speech.stop() }
    }

    private var setupPrompt: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("先接入一个项目", systemImage: "folder.badge.plus").font(.headline)
            Text("在 Codex 或 Claude Code 中打开项目并开始一次任务，Zimlo 会自动发现。你的输入会保留。")
                .font(.callout).foregroundStyle(NativeTheme.muted)
            HStack {
                Button("检查 Agent 接入") { saveDraft(); onSetup() }
                Button("重新检查项目") { Task { await store.refresh() } }
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private func saveDraft() {
        guard restored else { return }
        NativeComposerDraft(hostID: draftHostID ?? store.snapshot.host?.id, text: text,
                            workspaceID: workspaceID, provider: provider, materials: materials, unresolvedMaterialIDs: unresolvedMaterialIDs).save(key: draftKey)
    }

    private func dismissComposer() {
        guard !store.importingFiles else {
            store.showNotice("附件正在保存，完成后即可收起。")
            return
        }
        saveDraft()
        onDismiss()
    }

    private var header: some View {
        HStack(spacing: 12) {
            NativeTaskAvatar(project: project, provider: session?.provider ?? provider, size: 38)
            VStack(alignment: .leading, spacing: 2) {
                Text(session == nil ? "新任务" : "回复 Agent")
                    .font(.system(size: 17, weight: .bold, design: .rounded))
                Text(session?.title ?? project?.agentProfile.displayName ?? "把清晰目标交给 Agent")
                    .font(.callout)
                    .foregroundStyle(NativeTheme.muted)
                    .lineLimit(1)
            }
            Spacer()
            Text("点空白处或 Esc 收起")
                .font(.callout)
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
            .pickerStyle(.menu)
            .onChange(of: workspaceID) { _, _ in coerceProvider() }

            Picker("Runtime", selection: $provider) {
                ForEach(Provider.allCases) { item in Text(item.label).tag(item) }
            }
            .labelsHidden()
            .pickerStyle(.menu)
        }
        .fixedSize(horizontal: true, vertical: false)
        .frame(maxWidth: .infinity, alignment: .leading)
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
            NativeComposerDraft.clear(key: draftKey)
            if let entry = context.editingEntry { _ = store.outbox.discardFailure(entry.id) }
            if session == nil {
                UserDefaults.standard.set(workspaceID, forKey: "zimlo.mac.last-workspace")
                UserDefaults.standard.set(provider.rawValue, forKey: "zimlo.mac.last-provider")
            }
            onDismiss()
        }
    }

    private func restoreDefaults() {
        defer { restored = true }
        if let entry = context.editingEntry {
            text = entry.preview
            workspaceID = entry.command.values["workspaceId"]?.stringValue ?? ""
            provider = entry.command.values["provider"]?.stringValue.flatMap(Provider.init(rawValue:)) ?? session?.provider ?? .codex
            draftHostID = entry.hostID
            if case .array(let ids) = entry.command.values["materialIds"] {
                materials = ids.compactMap { id in store.snapshot.materials.first { $0.id == id.stringValue } }
                unresolvedMaterialIDs = ids.compactMap(\.stringValue).filter { id in !materials.contains { $0.id == id } }
            }
            return
        }
        if let draft = NativeComposerDraft.load(key: draftKey) {
            text = draft.text; workspaceID = draft.workspaceID; provider = draft.provider
            materials = draft.materials; draftHostID = draft.hostID
            unresolvedMaterialIDs = draft.unresolvedMaterialIDs ?? []
            return
        }
        draftHostID = store.snapshot.host?.id
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
