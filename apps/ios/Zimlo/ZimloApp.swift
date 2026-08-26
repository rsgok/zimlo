import SwiftUI

@main
struct ZimloApp: App {
    @UIApplicationDelegateAdaptor(ZimloAppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
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
}
