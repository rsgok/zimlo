import AppKit
import SwiftUI

@main
struct ZimloMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel.shared

    var body: some Scene {
        MenuBarExtra {
            MenuPanel(model: model)
        } label: {
            Label("Zimlo", systemImage: model.service.isReady ? "sparkles" : "sparkle")
        }
        .menuBarExtraStyle(.window)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        Task { await AppModel.shared.service.start() }
        if !AppModel.shared.onboarding.completed {
            WindowCoordinator.shared.showOnboarding()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationWillTerminate(_ notification: Notification) {
        AppModel.shared.service.stopOwnedService()
    }
}

@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()

    let service = ServiceController()
    let onboarding = OnboardingStore()
    let updates = UpdateController()

    private init() {}
}

@MainActor
final class WindowCoordinator: NSObject, NSWindowDelegate {
    static let shared = WindowCoordinator()
    private var onboardingWindow: NSWindow?

    func showOnboarding() {
        if let onboardingWindow {
            onboardingWindow.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let content = OnboardingView(model: AppModel.shared)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 840, height: 610),
            styleMask: [.titled, .closable, .miniaturizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Zimlo"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.center()
        window.contentView = NSHostingView(rootView: content)
        window.delegate = self
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        onboardingWindow = window
    }

    func closeOnboarding() {
        onboardingWindow?.close()
    }

    func windowWillClose(_ notification: Notification) {
        onboardingWindow = nil
    }
}
