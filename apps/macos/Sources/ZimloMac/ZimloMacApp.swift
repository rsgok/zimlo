import AppKit
import SwiftUI

enum MainWindowLayout {
    static let initialContentSize = NSSize(width: 1160, height: 760)
    static let minimumContentSize = NSSize(width: 920, height: 640)
}

@main
struct ZimloMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var service = AppModel.shared.service

    var body: some Scene {
        MenuBarExtra {
            MenuPanel(model: AppModel.shared)
        } label: {
            Image(nsImage: MenuBarAssets.icon(for: service.state))
                .accessibilityLabel("Zimlo")
                .accessibilityValue(service.state.label)
        }
        .menuBarExtraStyle(.window)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Zimlo has a real app window in addition to its menu-bar control.
        // A regular activation policy keeps the app discoverable in the Dock,
        // app switcher, and macOS application menu while that window is open.
        NSApp.setActivationPolicy(.regular)
        MacNotificationManager.shared.configure(requestPermission: AppModel.shared.onboarding.completed)
        Task { await AppModel.shared.service.start() }
        if !AppModel.shared.onboarding.completed {
            WindowCoordinator.shared.showOnboarding()
        } else {
            WindowCoordinator.shared.showMainApp()
        }
    }

    func applicationShouldHandleReopen(
        _ sender: NSApplication,
        hasVisibleWindows flag: Bool
    ) -> Bool {
        guard !flag else { return true }
        if AppModel.shared.onboarding.completed {
            WindowCoordinator.shared.showMainApp()
        } else {
            WindowCoordinator.shared.showOnboarding()
        }
        return true
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
    private static let menuDismissalDelay = Duration.milliseconds(180)
    private var onboardingWindow: NSWindow?
    private var mainAppWindow: NSWindow?
    private var mainAppRoute: LocalBridgeRoute?

    var mainWindowIsKey: Bool { mainAppWindow?.isKeyWindow == true }

    func openTask(sessionID: String) {
        showMainApp()
        Task { @MainActor in
            await Task.yield()
            NotificationCenter.default.post(name: .zimloOpenTask, object: sessionID)
        }
    }

    /// MenuBarExtra dismisses its AppKit panel with a transform animation. On
    /// macOS 26, ordering another window during that same animation can crash
    /// inside `_NSWindowTransformAnimation`. Let the panel finish first.
    func showMainAppFromMenu() {
        Task { @MainActor in
            try? await Task.sleep(for: Self.menuDismissalDelay)
            guard !Task.isCancelled else { return }
            showMainApp()
        }
    }

    func showOnboardingFromMenu() {
        Task { @MainActor in
            try? await Task.sleep(for: Self.menuDismissalDelay)
            guard !Task.isCancelled else { return }
            showOnboarding()
        }
    }

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
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = NSColor(
            calibratedRed: 0.045,
            green: 0.052,
            blue: 0.049,
            alpha: 1
        )
        window.animationBehavior = .none
        installBrandChrome(on: window)
        window.isMovableByWindowBackground = true
        window.center()
        window.contentView = NSHostingView(rootView: content)
        window.delegate = self
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        onboardingWindow = window
    }

    func closeOnboarding() {
        onboardingWindow?.orderOut(nil)
    }

    func showMainApp() {
        let descriptor = (try? Data(contentsOf: ServiceController.serviceDescriptorURL))
            .flatMap(ServiceDescriptor.decode)
        let route = LocalBridgeRoute.resolve(descriptor: descriptor)

        if let mainAppWindow {
            if mainAppRoute != route {
                mainAppWindow.contentView = NSHostingView(rootView: MainAppView(
                    route: route,
                    service: AppModel.shared.service
                ))
                mainAppRoute = route
            }
            mainAppWindow.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let content = MainAppView(route: route, service: AppModel.shared.service)
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: MainWindowLayout.initialContentSize),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Zimlo"
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = NSColor(
            calibratedRed: 0.045,
            green: 0.052,
            blue: 0.049,
            alpha: 1
        )
        window.animationBehavior = .none
        installBrandChrome(on: window)
        window.contentMinSize = MainWindowLayout.minimumContentSize
        window.collectionBehavior.insert(.fullScreenPrimary)
        window.center()
        window.contentView = NSHostingView(rootView: content)
        window.delegate = self
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        mainAppWindow = window
        mainAppRoute = route
    }

    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow else { return }
        if window === onboardingWindow {
            onboardingWindow = nil
        } else if window === mainAppWindow {
            mainAppWindow = nil
            mainAppRoute = nil
        }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard sender === onboardingWindow || sender === mainAppWindow else {
            return true
        }
        // Keep the native SwiftUI hierarchy alive for the lifetime of the
        // menu-bar app. Releasing and rebuilding it while NSStatusBarWindow is
        // draining can crash AppKit on macOS 26; hiding is also much faster on
        // the next open.
        sender.orderOut(nil)
        return false
    }

    private func installBrandChrome(on window: NSWindow) {
        window.title = "Zimlo"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        window.miniwindowImage = WindowBrandAssets.icon
    }
}

extension Notification.Name {
    static let zimloOpenTask = Notification.Name("app.zimlo.open-task")
}

@MainActor
enum WindowBrandAssets {
    static let icon: NSImage = {
        for resource in [("AppIcon-1024", "png"), ("AppIcon", "icns")] {
            guard let url = Bundle.main.url(forResource: resource.0, withExtension: resource.1),
                  let image = NSImage(contentsOf: url) else {
                continue
            }
            image.isTemplate = false
            return image
        }

        if let fallback = (NSApplication.shared.applicationIconImage.copy() as? NSImage)
            ?? NSApplication.shared.applicationIconImage {
            fallback.isTemplate = false
            return fallback
        }
        return NSImage(size: NSSize(width: 22, height: 22))
    }()
}

/// `MenuBarExtra` does not automatically treat a custom SwiftUI drawing as a
/// template image. On a selected menu-bar item that left the dark drawing on a
/// dark highlight, making the mark appear empty. Supplying a real template
/// `NSImage` lets AppKit apply the correct tint for every wallpaper, appearance,
/// accessibility contrast, and pressed state.
@MainActor
enum MenuBarAssets {
    static let size = NSSize(width: 18, height: 16)
    private static let readyIcon = makeIcon(for: .ready)
    private static let busyIcon = makeIcon(for: .starting)
    private static let stoppedIcon = makeIcon(for: .manualStopped)
    private static let degradedIcon = makeIcon(for: .degraded(""))
    private static let unavailableIcon = makeIcon(for: .unavailable(""))

    static func icon(for state: ServiceState) -> NSImage {
        switch state {
        case .ready: readyIcon
        case .starting, .stopping: busyIcon
        case .manualStopped: stoppedIcon
        case .degraded: degradedIcon
        case .unavailable: unavailableIcon
        }
    }

    private static func makeIcon(for state: ServiceState) -> NSImage {
        let image = NSImage(size: size, flipped: false) { rect in
            NSColor.black.setStroke()
            NSColor.black.setFill()

            drawGateway(in: rect)
            drawStatus(state, in: rect)
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "Zimlo"
        return image
    }

    private static func drawGateway(in rect: NSRect) {
        let mac = NSBezierPath()
        mac.lineWidth = 2
        mac.lineCapStyle = .round
        mac.lineJoinStyle = .round
        mac.move(to: NSPoint(x: rect.minX + 5, y: rect.maxY - 2))
        mac.line(to: NSPoint(x: rect.minX + 2, y: rect.maxY - 2))
        mac.line(to: NSPoint(x: rect.minX + 2, y: rect.minY + 2))
        mac.line(to: NSPoint(x: rect.minX + 5, y: rect.minY + 2))
        mac.stroke()

        let phone = NSBezierPath()
        phone.lineWidth = 1.6
        phone.lineCapStyle = .round
        phone.lineJoinStyle = .round
        phone.move(to: NSPoint(x: rect.maxX - 4, y: rect.maxY - 3))
        phone.line(to: NSPoint(x: rect.maxX - 2, y: rect.maxY - 3))
        phone.line(to: NSPoint(x: rect.maxX - 2, y: rect.minY + 3))
        phone.line(to: NSPoint(x: rect.maxX - 4, y: rect.minY + 3))
        phone.stroke()
    }

    private static func drawStatus(_ state: ServiceState, in rect: NSRect) {
        let center = NSPoint(x: rect.midX, y: rect.midY)
        switch state {
        case .ready:
            NSBezierPath(ovalIn: NSRect(x: center.x - 2.2, y: center.y - 2.2, width: 4.4, height: 4.4)).fill()
        case .starting, .stopping:
            let ring = NSBezierPath(ovalIn: NSRect(x: center.x - 2.5, y: center.y - 2.5, width: 5, height: 5))
            ring.lineWidth = 1.4
            ring.stroke()
        case .manualStopped:
            NSBezierPath(roundedRect: NSRect(x: center.x - 2.6, y: center.y - 0.8, width: 5.2, height: 1.6), xRadius: 0.8, yRadius: 0.8).fill()
        case .degraded:
            drawGlyph("!", at: center)
        case .unavailable:
            drawGlyph("×", at: center)
        }
    }

    private static func drawGlyph(_ value: String, at center: NSPoint) {
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 7, weight: .black),
            .foregroundColor: NSColor.black,
        ]
        let size = value.size(withAttributes: attributes)
        value.draw(
            at: NSPoint(x: center.x - size.width / 2, y: center.y - size.height / 2),
            withAttributes: attributes
        )
    }
}
