import AppKit
import SwiftUI

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
    private var mainAppWindow: NSWindow?
    private var mainAppRoute: MainAppRoute?

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
            contentRect: NSRect(x: 0, y: 0, width: 1160, height: 760),
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
        window.titleVisibility = .hidden
        window.minSize = NSSize(width: 860, height: 600)
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
