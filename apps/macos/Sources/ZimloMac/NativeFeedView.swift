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
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 15) {
                header
                if posts.isEmpty {
                    ContentUnavailableView(
                        "今天没有需要打断你的事",
                        systemImage: "sparkles",
                        description: Text("Agent 有值得阅读的结论或需要你决定时，会出现在这里。")
                    )
                    .frame(maxWidth: .infinity, minHeight: 360)
                    .foregroundStyle(NativeTheme.muted)
                } else {
                    ForEach(posts) { post in
                        NativeFeedCard(store: store, post: post)
                    }
                }
            }
            .padding(.horizontal, 28)
            .padding(.vertical, 24)
            .frame(maxWidth: 880, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .background(NativeTheme.paper)
        .navigationTitle("Feed")
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
        HStack(alignment: .bottom, spacing: 20) {
            VStack(alignment: .leading, spacing: 6) {
                Text("现在值得你看")
                    .font(.system(size: 28, weight: .bold, design: .rounded))
                    .foregroundStyle(NativeTheme.ink)
                Text("只保留结论、风险和真正需要你的下一步。")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(NativeTheme.muted)
            }
            Spacer()
            if let first = posts.first, !store.snapshot.seenPostIds.contains(first.id) {
                Label("\(posts.filter { !store.snapshot.seenPostIds.contains($0.id) }.count) 条未读", systemImage: "circle.fill")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(NativeTheme.acid)
            }
        }
        .padding(.bottom, 6)
    }
}

private struct NativeFeedCard: View {
    @ObservedObject var store: NativeAppStore
    let post: FeedPost

    private var project: Project? {
        post.projectId.flatMap { id in store.snapshot.projects.first { $0.id == id } }
    }
    private var pendingAction: PendingAction? {
        post.sessionId.flatMap(store.snapshot.pendingAction(for:))
    }
    private var isUnread: Bool { !store.snapshot.seenPostIds.contains(post.id) }

    var body: some View {
        Group {
            if let sessionID = post.sessionId {
                NavigationLink(value: NativeRoute.task(sessionID)) { cardBody }
                    .buttonStyle(.plain)
            } else {
                cardBody
            }
        }
        .task(id: post.id) {
            guard isUnread else { return }
            try? await Task.sleep(for: .milliseconds(900))
            guard !Task.isCancelled else { return }
            await store.markFeedSeen(post.id)
        }
        .contextMenu {
            Button("从 Feed 移除", systemImage: "eye.slash") {
                Task { await store.dismissFeedItem(post.id, dismissed: true) }
            }
        }
    }

    private var cardBody: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 11) {
                NativeAgentAvatar(avatar: project?.agentProfile.avatar ?? "●", size: 36)
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
        .padding(21)
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

    private var materialIDs: [String] {
        if let values = content.materialIds { return values }
        return [content.materialId, content.posterMaterialId, content.coverMaterialId].compactMap { $0 }
    }

    var body: some View {
        HStack(spacing: 10) {
            ForEach(materialIDs.prefix(3), id: \.self) { id in
                if let material = store.snapshot.materials.first(where: { $0.id == id }) {
                    Button { store.openMaterial(material) } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Image(systemName: symbol(for: material.kind))
                                .font(.system(size: 17, weight: .semibold))
                                .foregroundStyle(NativeTheme.acid)
                            Text(material.name)
                                .font(.system(size: 10, weight: .semibold))
                                .lineLimit(1)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10)
                        .background(NativeTheme.raised)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func symbol(for kind: String) -> String {
        ["image": "photo", "video": "play.rectangle.fill", "pdf": "doc.richtext.fill", "document": "doc.fill"][kind] ?? "paperclip"
    }
}
