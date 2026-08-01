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
            MenuBarStatusMark(state: service.state)
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
    private var mainAppRoute: MainAppRoute?

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
        let route = MainAppRoute.resolve(descriptor: descriptor)

        if let mainAppWindow {
            if mainAppRoute != route {
                mainAppWindow.contentView = NSHostingView(rootView: MainAppView(route: route))
                mainAppRoute = route
            }
            mainAppWindow.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let content = MainAppView(route: route)
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: MainWindowLayout.initialContentSize),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
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
        // Keep the SwiftUI/WKWebView hierarchy alive for the lifetime of the
        // menu-bar app. Releasing and rebuilding it while NSStatusBarWindow is
        // draining can crash AppKit on macOS 26; hiding is also much faster on
        // the next open.
        sender.orderOut(nil)
        return false
    }

    private func installBrandChrome(on window: NSWindow) {
        window.title = "Zimlo"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = false
        window.miniwindowImage = WindowBrandAssets.icon

        let accessory = NSTitlebarAccessoryViewController()
        accessory.layoutAttribute = .left
        accessory.view = makeWindowBrandView()
        window.addTitlebarAccessoryViewController(accessory)
    }

    private func makeWindowBrandView() -> NSView {
        let brand = NSView(frame: NSRect(x: 0, y: 0, width: 94, height: 28))

        let icon = NSImageView(image: WindowBrandAssets.icon)
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.imageAlignment = .alignCenter

        let title = NSTextField(labelWithString: "Zimlo")
        title.translatesAutoresizingMaskIntoConstraints = false
        title.font = .systemFont(ofSize: 12, weight: .semibold)
        title.textColor = .labelColor
        title.lineBreakMode = .byClipping

        brand.addSubview(icon)
        brand.addSubview(title)
        brand.setAccessibilityElement(true)
        brand.setAccessibilityLabel("Zimlo")

        NSLayoutConstraint.activate([
            brand.widthAnchor.constraint(equalToConstant: 94),
            brand.heightAnchor.constraint(equalToConstant: 28),
            icon.leadingAnchor.constraint(equalTo: brand.leadingAnchor, constant: 5),
            icon.centerYAnchor.constraint(equalTo: brand.centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 22),
            icon.heightAnchor.constraint(equalToConstant: 22),
            title.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 7),
            title.trailingAnchor.constraint(lessThanOrEqualTo: brand.trailingAnchor, constant: -4),
            title.centerYAnchor.constraint(equalTo: brand.centerYAnchor),
        ])

        return brand
    }
}

@MainActor
private enum WindowBrandAssets {
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

private struct MenuBarStatusMark: View {
    let state: ServiceState

    var body: some View {
        ZStack {
            GatewayMenuEnd(side: .mac)
                .stroke(.primary, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                .frame(width: 16, height: 13)
            GatewayMenuEnd(side: .phone)
                .stroke(.primary, style: StrokeStyle(lineWidth: 1.55, lineCap: .round, lineJoin: .round))
                .frame(width: 16, height: 13)
            statusIndicator
        }
        .frame(width: 18, height: 16)
    }

    @ViewBuilder
    private var statusIndicator: some View {
        switch state {
        case .ready:
            Circle().fill(.primary).frame(width: 4.5, height: 4.5)
        case .starting, .stopping:
            Circle().stroke(.primary, lineWidth: 1.4).frame(width: 5, height: 5)
        case .manualStopped:
            Capsule().fill(.primary).frame(width: 5, height: 1.7)
        case .degraded:
            Text("!").font(.system(size: 6, weight: .black, design: .rounded))
                .foregroundStyle(.primary)
        case .unavailable:
            Image(systemName: "xmark")
                .font(.system(size: 5.5, weight: .black))
                .foregroundStyle(.primary)
        }
    }
}

/// The wider Mac terminal and slimmer phone terminal remain distinguishable at
/// 16 px without using color, so the menu mark follows macOS template behavior.
private struct GatewayMenuEnd: Shape {
    enum Side { case mac, phone }
    let side: Side

    func path(in rect: CGRect) -> Path {
        var path = Path()
        switch side {
        case .mac:
            let inset: CGFloat = 1.1
            let arm: CGFloat = 5
            path.move(to: CGPoint(x: rect.minX + arm, y: rect.minY + inset))
            path.addLine(to: CGPoint(x: rect.minX + inset, y: rect.minY + inset))
            path.addLine(to: CGPoint(x: rect.minX + inset, y: rect.maxY - inset))
            path.addLine(to: CGPoint(x: rect.minX + arm, y: rect.maxY - inset))
        case .phone:
            let edge: CGFloat = 1.1
            let verticalInset: CGFloat = 2
            let arm: CGFloat = 3.6
            path.move(to: CGPoint(x: rect.maxX - arm, y: rect.minY + verticalInset))
            path.addLine(to: CGPoint(x: rect.maxX - edge, y: rect.minY + verticalInset))
            path.addLine(to: CGPoint(x: rect.maxX - edge, y: rect.maxY - verticalInset))
            path.addLine(to: CGPoint(x: rect.maxX - arm, y: rect.maxY - verticalInset))
        }
        return path
    }
}
