import AppKit
import SwiftUI
import WebKit

struct MainAppRoute: Equatable {
    static let defaultPort = 4747

    let url: URL

    static func resolve(descriptor: ServiceDescriptor?) -> MainAppRoute {
        let port: Int
        if let descriptor,
           HealthCheck.isCompatible(protocolVersion: descriptor.protocolVersion),
           (1...65_535).contains(descriptor.port) {
            port = descriptor.port
        } else {
            port = defaultPort
        }

        var components = URLComponents()
        components.scheme = "http"
        components.host = "127.0.0.1"
        components.port = port
        components.path = "/"
        components.queryItems = [
            URLQueryItem(name: "shell", value: "macos"),
            URLQueryItem(name: "theme", value: "dark"),
        ]
        return MainAppRoute(url: components.url!)
    }

    func allowsNavigation(to candidate: URL) -> Bool {
        guard candidate.scheme?.lowercased() == "http",
              let host = candidate.host?.lowercased(),
              ["127.0.0.1", "localhost", "::1"].contains(host) else {
            return false
        }
        return candidate.port == url.port
    }

    func request(reloadID: UUID) -> URLRequest {
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        components.queryItems = (components.queryItems ?? []) + [
            URLQueryItem(name: "desktopReload", value: reloadID.uuidString),
        ]
        var request = URLRequest(
            url: components.url!,
            cachePolicy: .reloadIgnoringLocalAndRemoteCacheData
        )
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        return request
    }
}

enum MainAppLoadPhase: Equatable {
    case loading
    case loaded
    case failed(String)
}

struct MainAppView: View {
    let route: MainAppRoute
    @ObservedObject var service: ServiceController

    @State private var phase: MainAppLoadPhase = .loading
    @State private var reloadID = UUID()

    var body: some View {
        ZStack {
            ZColor.paper.ignoresSafeArea()
            MainAppWebView(
                route: route,
                reloadID: reloadID,
                phase: $phase
            )

            switch phase {
            case .loading:
                loadingView
            case .loaded:
                EmptyView()
            case .failed(let message):
                failureView(message: message)
            }
        }
        .frame(minWidth: 860, minHeight: 600)
        .preferredColorScheme(.dark)
        .onChange(of: service.state) { previous, current in
            guard previous != .ready, current == .ready else { return }
            phase = .loading
            reloadID = UUID()
        }
    }

    private var loadingView: some View {
        VStack(spacing: 14) {
            ProgressView()
                .controlSize(.regular)
                .tint(ZColor.acid)
            Text("正在连接本地 Zimlo…")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(ZColor.muted)
        }
        .padding(24)
        .background(ZColor.surface.opacity(0.96))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(ZColor.border, lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("正在连接本地 Zimlo")
    }

    private func failureView(message: String) -> some View {
        VStack(spacing: 15) {
            ZStack {
                Circle()
                    .fill(ZColor.coralSoft)
                    .frame(width: 54, height: 54)
                Image(systemName: "wifi.exclamationmark")
                    .font(.system(size: 22, weight: .bold))
                    .foregroundStyle(ZColor.coral)
            }
            Text("本地界面暂时无法连接")
                .font(.system(size: 21, weight: .bold, design: .rounded))
                .foregroundStyle(ZColor.ink)
            Text(message)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(ZColor.muted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 360)
            Button {
                phase = .loading
                reloadID = UUID()
            } label: {
                Label("重新加载", systemImage: "arrow.clockwise")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(ZColor.onAccent)
                    .padding(.horizontal, 18)
                    .frame(height: 38)
                    .background(ZColor.acid)
                    .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
            }
            .buttonStyle(.plain)
            .accessibilityHint("重新连接本地 Zimlo 服务")
        }
        .padding(.horizontal, 38)
        .padding(.vertical, 34)
        .background(ZColor.surface.opacity(0.98))
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(ZColor.border, lineWidth: 1)
        }
        .shadow(color: .black.opacity(0.28), radius: 22, y: 10)
    }
}

private struct MainAppWebView: NSViewRepresentable {
    let route: MainAppRoute
    let reloadID: UUID
    @Binding var phase: MainAppLoadPhase

    func makeCoordinator() -> Coordinator {
        Coordinator(route: route, phase: $phase)
    }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.defaultWebpagePreferences.preferredContentMode = .desktop
        configuration.userContentController.addUserScript(WKUserScript(
            source: """
                document.documentElement.dataset.zimloShell = 'macos';
                document.documentElement.dataset.theme = 'dark';
                document.documentElement.classList.add('mac-dark');
                """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        configuration.userContentController.add(
            context.coordinator,
            name: WebSpeechBridge.messageHandlerName
        )

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        context.coordinator.attach(to: webView)
        webView.underPageBackgroundColor = NSColor(
            calibratedRed: 0.045,
            green: 0.052,
            blue: 0.049,
            alpha: 1
        )
        context.coordinator.lastReloadID = reloadID
        webView.load(route.request(reloadID: reloadID))
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.route = route
        context.coordinator.phase = $phase
        guard context.coordinator.lastReloadID != reloadID else { return }
        context.coordinator.lastReloadID = reloadID
        webView.load(route.request(reloadID: reloadID))
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var route: MainAppRoute
        var phase: Binding<MainAppLoadPhase>
        var lastReloadID: UUID?
        private let speechBridge = WebSpeechBridge()

        init(route: MainAppRoute, phase: Binding<MainAppLoadPhase>) {
            self.route = route
            self.phase = phase
        }

        func attach(to webView: WKWebView) {
            speechBridge.attach(to: webView)
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            speechBridge.handle(message)
        }

        func webView(
            _ webView: WKWebView,
            runOpenPanelWith parameters: WKOpenPanelParameters,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping @MainActor ([URL]?) -> Void
        ) {
            let panel = NSOpenPanel()
            panel.canChooseFiles = true
            panel.canChooseDirectories = parameters.allowsDirectories
            panel.allowsMultipleSelection = parameters.allowsMultipleSelection

            let complete: @MainActor (NSApplication.ModalResponse) -> Void = { response in
                completionHandler(response == .OK ? panel.urls : nil)
            }
            if let window = webView.window {
                panel.beginSheetModal(for: window, completionHandler: complete)
            } else {
                panel.begin(completionHandler: complete)
            }
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
        ) {
            guard let candidate = navigationAction.request.url,
                  route.allowsNavigation(to: candidate) else {
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation?) {
            phase.wrappedValue = .loading
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation?) {
            phase.wrappedValue = .loaded
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation?,
            withError error: Error
        ) {
            report(error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation?, withError error: Error) {
            report(error)
        }

        private func report(_ error: Error) {
            let code = (error as? URLError)?.code
            guard code != .cancelled else { return }
            let message: String
            switch code {
            case .cannotConnectToHost, .networkConnectionLost, .notConnectedToInternet, .timedOut:
                message = "请确认后台服务正在运行，然后重试。关闭这个窗口不会停止服务。"
            default:
                message = "页面加载失败。请稍后重试，或从菜单栏检查后台服务。"
            }
            phase.wrappedValue = .failed(message)
        }
    }
}
