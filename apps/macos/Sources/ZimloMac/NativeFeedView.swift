import SwiftUI

struct NativeFeedView: View {
    @ObservedObject var store: NativeAppStore

    private var posts: [FeedPost] {
        let dismissed = Set(store.snapshot.dismissedFeedItemIds)
        let seen = Set(store.snapshot.seenPostIds)
        return store.snapshot.posts
            .filter { !dismissed.contains($0.id) }
            .sorted { left, right in
                let leftAction = left.sessionId.flatMap(store.snapshot.pendingAction(for:)) != nil
                let rightAction = right.sessionId.flatMap(store.snapshot.pendingAction(for:)) != nil
                if leftAction != rightAction { return leftAction }
                let leftUnread = !seen.contains(left.id)
                let rightUnread = !seen.contains(right.id)
                if leftUnread != rightUnread { return leftUnread }
                return left.createdAt > right.createdAt
            }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, 30)
                .padding(.vertical, 22)
                .frame(maxWidth: 960)
                .frame(maxWidth: .infinity)
            Divider().opacity(0.42)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 28) {
                if posts.isEmpty {
                    ContentUnavailableView("All Caught Up", systemImage: "checkmark.circle.fill")
                    .frame(maxWidth: .infinity, minHeight: 360)
                    .foregroundStyle(NativeTheme.muted)
                } else {
                    ForEach(posts) { post in
                        NativeFeedCard(store: store, post: post)
                    }
                }
                }
                .scrollTargetLayout()
                .padding(.horizontal, 30)
                .padding(.vertical, 28)
                .frame(maxWidth: 960, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .center)
            }
            .scrollTargetBehavior(.viewAligned)
        }
        .background(NativeTheme.paper)
        .navigationTitle("For You")
        .toolbar {
            ToolbarItem {
                Button { Task { await store.refresh() } } label: {
                    Label("刷新", systemImage: "arrow.clockwise")
                }
                .help("刷新 Feed")
            }
        }
    }

    private var header: some View {
        Text("For You")
            .font(.system(size: 28, weight: .bold, design: .rounded))
            .foregroundStyle(NativeTheme.ink)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

enum NativeFeedArchiveGesture {
    static let archiveThreshold: CGFloat = 112

    static func horizontalOffset(for translation: CGSize) -> CGFloat {
        guard translation.width < 0,
              abs(translation.width) > abs(translation.height) * 1.15 else { return 0 }
        return translation.width
    }

    static func shouldArchive(translation: CGSize, predicted: CGSize) -> Bool {
        horizontalOffset(for: translation) <= -archiveThreshold
            || horizontalOffset(for: predicted) <= -(archiveThreshold * 1.55)
    }
}

private struct NativeFeedCard: View {
    @ObservedObject var store: NativeAppStore
    let post: FeedPost
    @State private var dragOffset: CGFloat = 0
    @State private var isArchiving = false

    private var project: Project? {
        if let id = post.projectId,
           let project = store.snapshot.projects.first(where: { $0.id == id }) {
            return project
        }
        guard let sessionID = post.sessionId,
              let session = store.snapshot.sessions.first(where: { $0.id == sessionID }) else { return nil }
        return store.snapshot.project(for: session)
    }
    private var session: AgentSession? {
        guard let sessionID = post.sessionId else { return nil }
        return store.snapshot.sessions.first(where: { $0.id == sessionID })
    }
    private var pendingAction: PendingAction? {
        post.sessionId.flatMap(store.snapshot.pendingAction(for:))
    }
    private var isUnread: Bool { !store.snapshot.seenPostIds.contains(post.id) }

    var body: some View {
        ZStack(alignment: .trailing) {
            archiveBackground
            Group {
                if let sessionID = post.sessionId {
                    NavigationLink(value: NativeRoute.task(sessionID)) { cardBody }
                        .buttonStyle(.plain)
                } else {
                    cardBody
                }
            }
            .offset(x: dragOffset)
            .opacity(isArchiving ? 0.72 : 1)
        }
        .clipShape(RoundedRectangle(cornerRadius: 19, style: .continuous))
        .highPriorityGesture(archiveGesture)
        .accessibilityAction(named: "归档") { archive() }
        .onAppear {
            // Lazy stacks may reuse a card's view state if an archive is undone
            // before the row is fully discarded. Always re-enter at rest.
            dragOffset = 0
            isArchiving = false
        }
        .task(id: post.id) {
            guard isUnread else { return }
            try? await Task.sleep(for: .milliseconds(900))
            guard !Task.isCancelled else { return }
            await store.markFeedSeen(post.id)
        }
        .contextMenu {
            Button("归档", systemImage: "archivebox") {
                archive()
            }
        }
    }

    private var archiveBackground: some View {
        RoundedRectangle(cornerRadius: 19, style: .continuous)
            .fill(NativeTheme.sage.opacity(0.18))
            .overlay(alignment: .trailing) {
                Label("归档", systemImage: "archivebox.fill")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(NativeTheme.sage)
                    .padding(.trailing, 30)
                    .opacity(min(1, abs(dragOffset) / NativeFeedArchiveGesture.archiveThreshold))
            }
    }

    private var archiveGesture: some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { value in
                guard !isArchiving else { return }
                dragOffset = NativeFeedArchiveGesture.horizontalOffset(for: value.translation)
            }
            .onEnded { value in
                guard !isArchiving else { return }
                if NativeFeedArchiveGesture.shouldArchive(
                    translation: value.translation,
                    predicted: value.predictedEndTranslation
                ) {
                    archive()
                } else {
                    withAnimation(.spring(response: 0.32, dampingFraction: 0.82)) { dragOffset = 0 }
                }
            }
    }

    private func archive() {
        guard !isArchiving else { return }
        isArchiving = true
        withAnimation(.easeIn(duration: 0.18)) { dragOffset = -1_100 }
        Task {
            try? await Task.sleep(for: .milliseconds(180))
            if !(await store.dismissFeedItem(post.id, dismissed: true)) {
                isArchiving = false
                withAnimation(.spring(response: 0.34, dampingFraction: 0.82)) { dragOffset = 0 }
            }
        }
    }

    private var cardBody: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 11) {
                if let project {
                    NativeAgentAvatar(avatar: project.agentProfile.avatar, size: 36)
                } else {
                    NativeTaskAvatar(project: nil, provider: session?.provider ?? .codex, size: 36)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(project?.agentProfile.displayName ?? post.agentId)
                        .font(.system(size: 12, weight: .bold))
                    Text(post.createdAt.zimloDate.formatted(date: .abbreviated, time: .shortened))
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(NativeTheme.muted)
                }
                Spacer()
                NativeFeedKindPill(kind: post.kind)
                if isUnread {
                    Circle().fill(NativeTheme.acid).frame(width: 7, height: 7)
                }
            }
            .padding(.bottom, 18)

            Text(post.headline)
                .font(.system(size: 23, weight: .bold, design: .rounded))
                .foregroundStyle(NativeTheme.ink)
                .fixedSize(horizontal: false, vertical: true)

            Text(post.takeaway)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(NativeTheme.ink.opacity(0.76))
                .lineSpacing(4)
                .padding(.top, 9)
                .fixedSize(horizontal: false, vertical: true)

            if !post.highlights.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(post.highlights.prefix(2), id: \.self) { highlight in
                        HStack(alignment: .firstTextBaseline, spacing: 9) {
                            Image(systemName: "checkmark")
                                .font(.system(size: 10, weight: .black))
                                .foregroundStyle(NativeTheme.acid)
                            Text(highlight)
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(NativeTheme.ink.opacity(0.86))
                        }
                    }
                }
                .padding(.top, 15)
            }

            if let content = post.content {
                NativeFeedMaterialSummary(store: store, content: content)
                    .padding(.top, 16)
            }

            Spacer(minLength: 24)

            HStack(spacing: 10) {
                if let proof = post.proof, !proof.isEmpty {
                    Label(proof, systemImage: "checkmark.seal.fill")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(NativeTheme.muted)
                        .lineLimit(1)
                }
                Spacer()
                if let pendingAction {
                    Label(pendingAction.title, systemImage: "arrow.right.circle.fill")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(NativeTheme.coral)
                        .lineLimit(1)
                } else if post.sessionId != nil {
                    Label("查看任务", systemImage: "arrow.right")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(NativeTheme.acid)
                }
            }
            .padding(.top, 18)
        }
        .padding(28)
        .frame(maxWidth: .infinity, minHeight: 360, alignment: .topLeading)
        .nativeCard(cornerRadius: 19)
        .overlay(alignment: .leading) {
            RoundedRectangle(cornerRadius: 2)
                .fill(accentColor)
                .frame(width: 3)
                .padding(.vertical, 18)
        }
    }

    private var accentColor: Color {
        switch post.kind {
        case "failure": NativeTheme.coral
        case "attention", "decision": NativeTheme.amber
        case "result": NativeTheme.sage
        default: NativeTheme.acid
        }
    }
}

private struct NativeFeedKindPill: View {
    let kind: String
    private var label: String {
        ["progress": "进展", "decision": "判断", "attention": "需要关注", "result": "结论", "failure": "风险"][kind] ?? "动态"
    }
    var body: some View {
        Text(label)
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(NativeTheme.ink.opacity(0.7))
            .padding(.horizontal, 8)
            .frame(height: 23)
            .background(NativeTheme.raised)
            .clipShape(Capsule())
    }
}

private struct NativeFeedMaterialSummary: View {
    @ObservedObject var store: NativeAppStore
    let content: FeedContent

    private var presentation: NativeFeedMaterialPresentation {
        NativeFeedMaterialPresentation(content: content)
    }

    private func material(_ id: String?) -> Material? {
        guard let id else { return nil }
        return store.snapshot.materials.first { $0.id == id && $0.status == "ready" }
    }

    @ViewBuilder
    var body: some View {
        switch presentation {
        case .imageAlbum(let ids):
            let images = ids.prefix(3).compactMap { material($0) }
            if !images.isEmpty {
                HStack(spacing: 10) {
                    ForEach(images) { image in
                        NativeFeedImagePreview(
                            material: image,
                            url: store.materialURL(image),
                            height: images.count == 1 ? 220 : 180
                        ) { store.openMaterial(image) }
                    }
                }
                if let caption = content.caption, !caption.isEmpty {
                    Text(caption)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(NativeTheme.muted)
                        .padding(.top, 7)
                }
            }
        case .video(let materialID, let posterID):
            if let video = material(materialID), let poster = material(posterID) {
                NativeFeedImagePreview(
                    material: poster,
                    url: store.materialURL(poster),
                    height: 210,
                    showsPlayButton: true
                ) { store.openMaterial(video) }
            } else if let video = material(materialID) {
                attachmentButton(video)
            }
        case .document(let materialID, _):
            if let document = material(materialID) { attachmentButton(document) }
        case .none:
            EmptyView()
        }
    }

    private func attachmentButton(_ material: Material) -> some View {
        Button { store.openMaterial(material) } label: {
            HStack(spacing: 10) {
                Image(systemName: symbol(for: material.kind))
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(NativeTheme.acid)
                Text(material.name)
                    .font(.system(size: 10, weight: .semibold))
                    .lineLimit(1)
                Spacer()
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(NativeTheme.muted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(NativeTheme.raised)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private func symbol(for kind: String) -> String {
        ["image": "photo", "video": "play.rectangle.fill", "pdf": "doc.richtext.fill", "document": "doc.fill"][kind] ?? "paperclip"
    }
}

private struct NativeFeedImagePreview: View {
    let material: Material
    let url: URL
    let height: CGFloat
    var showsPlayButton = false
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            AsyncImage(url: url, transaction: Transaction(animation: .easeInOut(duration: 0.18))) { phase in
                ZStack {
                    NativeTheme.raised
                    switch phase {
                    case .empty:
                        ProgressView().controlSize(.small).tint(NativeTheme.muted)
                    case .success(let image):
                        image
                            .resizable()
                            .interpolation(.high)
                            .scaledToFit()
                            .padding(8)
                    case .failure:
                        VStack(spacing: 7) {
                            Image(systemName: "photo.badge.exclamationmark")
                                .font(.system(size: 20, weight: .semibold))
                            Text("图片暂时无法加载")
                                .font(.system(size: 10, weight: .semibold))
                        }
                        .foregroundStyle(NativeTheme.muted)
                    @unknown default:
                        EmptyView()
                    }

                    if showsPlayButton {
                        Image(systemName: "play.fill")
                            .font(.system(size: 17, weight: .bold))
                            .foregroundStyle(NativeTheme.ink)
                            .frame(width: 44, height: 44)
                            .background(.black.opacity(0.66))
                            .clipShape(Circle())
                    }
                }
                .frame(maxWidth: .infinity)
                .frame(height: height)
            }
            .overlay(alignment: .bottomLeading) {
                Text(material.name)
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(NativeTheme.ink)
                    .lineLimit(1)
                    .padding(.horizontal, 10)
                    .frame(height: 30)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.black.opacity(0.58))
            }
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(NativeTheme.border, lineWidth: 1)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("打开图片 \(material.name)")
    }
}
