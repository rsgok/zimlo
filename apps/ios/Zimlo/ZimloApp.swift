import SwiftUI

@main
struct ZimloApp: App {
    @UIApplicationDelegateAdaptor(ZimloAppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            #if DEBUG
            if let path = artifactReviewDirectory {
                ArtifactDeliveryReview(directory: path)
            } else { liveContent }
            #else
            liveContent
            #endif
        }
    }

    #if DEBUG
    private var artifactReviewDirectory: String? {
        let prefix = "--artifact-review-directory="
        return ProcessInfo.processInfo.arguments.first { $0.hasPrefix(prefix) }.map { String($0.dropFirst(prefix.count)) }
            ?? ProcessInfo.processInfo.environment["ZIMLO_ARTIFACT_REVIEW_DIR"]
    }
    #endif

    private var liveContent: some View {
            RootView(model: model)
                .preferredColorScheme(.dark)
                .onAppear { model.start() }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active {
                        model.start()
                        NotificationManager.shared.clearBadge()
                        // 回前台重检测通知权限（用户可能刚从系统设置回来）。
                        model.refreshNotificationPermission()
                    } else if phase == .background {
                        model.stop()
                    }
                }
    }
}
