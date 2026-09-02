import SwiftUI

struct NativeFeedView: View {
    @ObservedObject var store: NativeAppStore
    let scrollToLatestRequest: Int

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
        GeometryReader { geometry in
            ZStack(alignment: .top) {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            if posts.isEmpty {
                                ContentUnavailableView("All Caught Up", systemImage: "checkmark.circle.fill")
                                    .frame(maxWidth: .infinity)
                                    .frame(height: geometry.size.height)
                                    .foregroundStyle(NativeTheme.muted)
                                    .id(NativeFeedScrollAnchor.latest)
                            } else {
                                ForEach(posts) { post in
                                    NativeFeedCard(
                                        store: store,
                                        post: post,
                                        minimumHeight: NativeFeedLayout.cardMinimumHeight(
                                            scrollViewportHeight: geometry.size.height
                                        )
                                    )
                                    .padding(.vertical, NativeFeedLayout.edgeInset)
                                    // The scroll target occupies exactly one viewport;
                                    // the shorter card is centered inside that page.
                                    .frame(height: geometry.size.height, alignment: .center)
                                    .id(post.id)
                                }
                            }
                        }
                        .scrollTargetLayout()
                        .padding(.horizontal, NativeFeedLayout.edgeInset)
                        .frame(maxWidth: NativeFeedLayout.maximumCardWidth, alignment: .leading)
                        .frame(maxWidth: .infinity, alignment: .center)
                    }
                    .scrollIndicators(.hidden)
                    // Snap each trackpad or wheel gesture with the chosen card centered
                    // in the viewport instead of pinning its top edge to the window.
                    .nativeFeedScrollTargetBehavior()
                    .onChange(of: scrollToLatestRequest) { _, _ in
                        withAnimation(.snappy(duration: 0.24)) {
                            if let latestID = posts.first?.id {
                                proxy.scrollTo(latestID, anchor: .center)
                            } else {
                                proxy.scrollTo(NativeFeedScrollAnchor.latest, anchor: .top)
                            }
                        }
                    }
                }

                // macOS lets scrolling content travel beneath the transparent titlebar.
                // Keep neighboring cards out of that chrome while retaining native scrolling.
                NativeTheme.paper
                    .frame(height: geometry.safeAreaInsets.top)
                    .ignoresSafeArea(.container, edges: .top)
                    .allowsHitTesting(false)
            }
        }
        .background(NativeTheme.paper)
    }
}

private extension View {
    @ViewBuilder
    func nativeFeedScrollTargetBehavior() -> some View {
        if #available(macOS 26.0, *) {
            scrollTargetBehavior(.viewAligned(limitBehavior: .alwaysByOne, anchor: .center))
        } else if #available(macOS 15.0, *) {
            scrollTargetBehavior(.viewAligned(limitBehavior: .alwaysByOne))
        } else {
            scrollTargetBehavior(.viewAligned)
        }
    }
}

enum NativeFeedLayout {
    static let maximumCardWidth: CGFloat = 720
    static let edgeInset: CGFloat = 28

    static func cardMinimumHeight(scrollViewportHeight: CGFloat) -> CGFloat {
        max(500, scrollViewportHeight - edgeInset * 2)
    }
}

private enum NativeFeedScrollAnchor {
    static let latest = "native-feed-latest"
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
    let minimumHeight: CGFloat
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
    private var palette: ZimloCardPalette { ZimloCardPalette(theme: post.presentation.theme) }
    private var mediaContent: FeedContent? {
        guard let content = post.content, content.type != "text" else { return nil }
        return content
    }
    private var isFullBleed: Bool { post.presentation.mediaPlacement == "full_bleed" && mediaContent != nil }
    private var cardPadding: CGFloat {
        switch post.presentation.density {
        case "airy": 34
        case "compact": 22
        default: 28
        }
    }
    private var titleDesign: Font.Design {
        switch post.presentation.typography {
        case "serif": .serif
        case "mono": .monospaced
        case "rounded": .rounded
        default: .default
        }
    }

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
        ZStack {
            palette.surface
            if isFullBleed, let mediaContent {
                NativeFeedMaterialSummary(store: store, content: mediaContent)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .opacity(0.9)
                LinearGradient(colors: [.black.opacity(0.54), .clear, .black.opacity(0.86)], startPoint: .top, endPoint: .bottom)
            }
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 11) {
                    if let project {
                        NativeAgentAvatar(avatar: project.agentProfile.avatar, size: 34)
                    } else {
                        NativeTaskAvatar(project: nil, provider: session?.provider ?? .codex, size: 34)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(project?.agentProfile.displayName ?? post.agentId)
                            .font(.system(size: 12, weight: .bold))
                        Text(post.createdAt.zimloDate.formatted(date: .abbreviated, time: .shortened))
                            .font(.system(size: 10, weight: .medium))
                            .opacity(0.62)
                    }
                    Spacer()
                    Text("\(post.kind.uppercased()) / \(post.presentation.system.uppercased())")
                        .font(.system(size: 9, weight: .black, design: .monospaced))
                        .tracking(1)
                        .foregroundStyle(isFullBleed ? Color.white.opacity(0.78) : palette.accent)
                    if isUnread { Circle().fill(isFullBleed ? Color.white : palette.accent).frame(width: 7, height: 7) }
                }
                .foregroundStyle(isFullBleed ? Color.white : palette.ink)
                .padding(.bottom, 20)

                if post.presentation.mediaPlacement == "split", let mediaContent {
                    HStack(alignment: .center, spacing: 24) {
                        NativeFeedMaterialSummary(store: store, content: mediaContent)
                            .frame(maxWidth: .infinity)
                        copy.frame(maxWidth: .infinity, alignment: .leading)
                    }
                } else {
                    if !isFullBleed, let mediaContent {
                        NativeFeedMaterialSummary(store: store, content: mediaContent)
                            .padding(.bottom, 18)
                    }
                    copy
                }

                Spacer(minLength: 24)
                HStack(spacing: 10) {
                    if let proof = post.proof, !proof.isEmpty {
                        Label(proof, systemImage: "checkmark.seal.fill")
                            .font(.system(size: 10, weight: .semibold, design: .monospaced))
                            .lineLimit(1)
                    }
                    Spacer()
                    if let pendingAction {
                        Label(pendingAction.title, systemImage: "arrow.right.circle.fill")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(isFullBleed ? Color.white : palette.accent)
                            .lineLimit(1)
                    } else if post.sessionId != nil {
                        Label("查看任务", systemImage: "arrow.right")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(isFullBleed ? Color.white : palette.accent)
                    }
                }
                .foregroundStyle(isFullBleed ? Color.white.opacity(0.76) : palette.ink.opacity(0.66))
                .padding(.top, 14)
                .overlay(alignment: .top) { Rectangle().fill(isFullBleed ? Color.white.opacity(0.22) : palette.ink.opacity(0.18)).frame(height: 1) }
            }
            .padding(cardPadding)
        }
        .frame(maxWidth: .infinity, minHeight: minimumHeight, alignment: .topLeading)
        .clipShape(RoundedRectangle(cornerRadius: post.presentation.system == "swiss" ? 7 : 20, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: post.presentation.system == "swiss" ? 7 : 20, style: .continuous)
                .stroke(isFullBleed ? Color.white.opacity(0.2) : palette.ink.opacity(0.22), lineWidth: post.presentation.system == "swiss" ? 2 : 1)
        }
        .shadow(color: post.presentation.system == "swiss" ? palette.accent : .black.opacity(0.24), radius: post.presentation.system == "swiss" ? 0 : 18, x: post.presentation.system == "swiss" ? 7 : 0, y: post.presentation.system == "swiss" ? 7 : 12)
    }

    private var copy: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(post.headline)
                .font(.system(size: post.presentation.density == "compact" ? 28 : 38, weight: post.presentation.system == "swiss" ? .black : .bold, design: titleDesign))
                .tracking(-1.2)
                .foregroundStyle(isFullBleed ? Color.white : palette.ink)
                .fixedSize(horizontal: false, vertical: true)
            Text(post.takeaway)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(isFullBleed ? Color.white.opacity(0.74) : palette.ink.opacity(0.72))
                .lineSpacing(4)
                .padding(.top, 12)
                .fixedSize(horizontal: false, vertical: true)
            NativeCardBlocksView(blocks: post.blocks, palette: palette, fullBleed: isFullBleed, layout: post.presentation.layout)
                .padding(.top, post.blocks.isEmpty ? 0 : 18)
            if !post.highlights.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(post.highlights.prefix(2), id: \.self) { highlight in
                        HStack(alignment: .firstTextBaseline, spacing: 9) {
                            Image(systemName: "checkmark").font(.system(size: 10, weight: .black)).foregroundStyle(isFullBleed ? Color.white : palette.accent)
                            Text(highlight).font(.system(size: 12, weight: .semibold))
                        }
                    }
                }
                .foregroundStyle(isFullBleed ? Color.white.opacity(0.82) : palette.ink.opacity(0.82))
                .padding(.top, 15)
            }
        }
    }
}

private struct NativeCardBlocksView: View {
    let blocks: [CardBlock]
    let palette: ZimloCardPalette
    let fullBleed: Bool
    let layout: String

    private var foreground: Color { fullBleed ? .white : palette.ink }

    var body: some View {
        if layout == "metric_grid" {
            LazyVGrid(columns: [.init(.flexible()), .init(.flexible())], spacing: 0) { blockViews }
        } else {
            VStack(alignment: .leading, spacing: 0) { blockViews }
        }
    }

    @ViewBuilder private var blockViews: some View {
        ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
            switch block.type {
            case "metric":
                VStack(alignment: .leading, spacing: 8) {
                    Text(block.label ?? "METRIC").font(.system(size: 9, weight: .black, design: .monospaced))
                    Text((block.value ?? "—") + (block.unit.map { " \($0)" } ?? ""))
                        .font(.system(size: 30, weight: .black, design: .rounded))
                    if let caption = block.caption { Text(caption).font(.system(size: 10, weight: .medium)).opacity(0.62) }
                }
                .padding(12).frame(maxWidth: .infinity, minHeight: 108, alignment: .leading)
                .background(index == 0 && !fullBleed ? palette.accent : foreground.opacity(0.05))
                .overlay(Rectangle().stroke(foreground.opacity(0.45), lineWidth: 1))
            case "quote":
                VStack(alignment: .leading, spacing: 8) {
                    Text("“\(block.text ?? "")”").font(.system(size: 22, weight: .bold, design: .serif))
                    if let attribution = block.attribution { Text("— \(attribution)").font(.system(size: 10, weight: .semibold)) }
                }
                .padding(.leading, 14).overlay(alignment: .leading) { Rectangle().fill(fullBleed ? .white : palette.accent).frame(width: 5) }
            case "comparison":
                HStack(spacing: 0) {
                    comparison(block.left, highlighted: false)
                    comparison(block.right, highlighted: true)
                }
            case "step":
                HStack(alignment: .top, spacing: 11) {
                    Text(String(format: "%02d", index + 1)).font(.system(size: 10, weight: .black, design: .monospaced)).foregroundStyle(fullBleed ? .white : palette.accent)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(block.label ?? "").font(.system(size: 12, weight: .bold))
                        if let detail = block.detail { Text(detail).font(.system(size: 10, weight: .medium)).opacity(0.64) }
                    }
                }
                .padding(.vertical, 9).frame(maxWidth: .infinity, alignment: .leading)
                .background(block.phase == "current" ? palette.accent : .clear)
                .overlay(alignment: .top) { Rectangle().fill(foreground.opacity(0.2)).frame(height: 1) }
            default:
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(block.label ?? "FACT").font(.system(size: 9, weight: .black, design: .monospaced)).foregroundStyle(fullBleed ? .white : palette.accent)
                        if let detail = block.detail { Text(detail).font(.system(size: 10, weight: .medium)).opacity(0.64) }
                    }
                    Spacer()
                    if let value = block.value { Text(value).font(.system(size: 13, weight: .bold)) }
                }
                .padding(.vertical, 9).overlay(alignment: .top) { Rectangle().fill(foreground.opacity(0.2)).frame(height: 1) }
            }
        }
    }

    private func comparison(_ item: CardComparisonItem?, highlighted: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(item?.label ?? "—").font(.system(size: 9, weight: .black, design: .monospaced))
            Text(item?.value ?? "—").font(.system(size: 16, weight: .bold))
            if let detail = item?.detail { Text(detail).font(.system(size: 10, weight: .medium)).opacity(0.64) }
        }
        .padding(11).frame(maxWidth: .infinity, alignment: .leading)
        .background(highlighted && !fullBleed ? palette.accent : foreground.opacity(0.04))
        .overlay(Rectangle().stroke(foreground.opacity(0.45), lineWidth: 1))
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
