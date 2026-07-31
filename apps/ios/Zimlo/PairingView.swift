import AVFoundation
import SwiftUI
import UIKit

struct PairingView: View {
    @ObservedObject var model: AppModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var link = ""
    @State private var scanning = false
    @State private var connecting = false
    @FocusState private var linkFocused: Bool

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(spacing: 22) {
                    Spacer(minLength: dynamicTypeSize.isAccessibilitySize ? 8 : 36)

                    ZimloAvatar(size: dynamicTypeSize.isAccessibilitySize ? 64 : 72)
                        .accessibilityHidden(true)

                    VStack(spacing: 7) {
                        Text("连接你的 Mac")
                            .font(ZFont.title)
                            .fixedSize(horizontal: false, vertical: true)
                        Text("在 Mac 上生成二维码后直接扫描。无需接入同一网络，密钥只保存在你的设备上。")
                            .font(ZFont.subheadline)
                            .foregroundStyle(ZColor.muted)
                            .multilineTextAlignment(.center)
                            .lineSpacing(3)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    Button {
                        linkFocused = false
                        scanning = true
                    } label: {
                        Label("扫描配对二维码", systemImage: "qrcode.viewfinder")
                    }
                    .buttonStyle(PairingButtonStyle())
                    .disabled(connecting)
                    .accessibilityHint("打开相机，扫描 Mac 上显示的二维码")

                    if dynamicTypeSize.isAccessibilitySize {
                        Text("或粘贴配对链接")
                            .font(ZFont.footnote.weight(.semibold))
                            .foregroundStyle(ZColor.muted)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                    } else {
                        HStack {
                            Rectangle().fill(ZColor.line).frame(height: 1)
                            Text("或粘贴配对链接")
                                .font(ZFont.caption2)
                                .foregroundStyle(ZColor.muted)
                                .fixedSize()
                            Rectangle().fill(ZColor.line).frame(height: 1)
                        }
                    }

                    TextField("粘贴 Zimlo 配对链接", text: $link)
                        .focused($linkFocused)
                        .textInputAutocapitalization(.never)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                        .submitLabel(.go)
                        .font(.footnote.monospaced())
                        .padding(14)
                        .background(ZColor.control)
                        .clipShape(RoundedRectangle(cornerRadius: ZRadius.control, style: .continuous))
                        .accessibilityLabel("Zimlo 配对链接")
                        .onSubmit { connect(link) }

                    Button {
                        connect(link)
                    } label: {
                        HStack(spacing: 8) {
                            if connecting { ProgressView().tint(ZColor.onAccent) }
                            Text(connecting ? "正在连接" : "连接")
                        }
                    }
                    .buttonStyle(PairingButtonStyle())
                    .disabled(connecting || PairingLinkRules.validatedURL(link) == nil)

                    if !connecting, let error = model.bridge.error {
                        Text(userFacingPairingError(error))
                            .font(ZFont.footnote.weight(.semibold))
                            .foregroundStyle(ZColor.coralText)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityLabel("连接失败：\(userFacingPairingError(error))")
                    }

                    Spacer(minLength: dynamicTypeSize.isAccessibilitySize ? 8 : 32)
                    Text("任务内容端到端加密 · 云端只负责连接设备")
                        .font(ZFont.footnote.weight(.semibold))
                        .foregroundStyle(ZColor.muted)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(minHeight: max(0, geometry.size.height - 60))
                .padding(.horizontal, 28)
                .padding(.vertical, 30)
            }
            .scrollDismissesKeyboard(.interactively)
            .scrollBounceBehavior(.basedOnSize)
            .foregroundStyle(ZColor.ink)
            .background(ZColor.canvas)
        }
        .sheet(isPresented: $scanning) {
            ZStack(alignment: .topTrailing) {
                QRScannerView { value in
                    scanning = false
                    link = value
                    connect(value)
                }
                Button { scanning = false } label: {
                    Image(systemName: "xmark")
                        .font(.body.weight(.bold))
                        .foregroundStyle(ZColor.ink)
                        .frame(width: 44, height: 44)
                        .background(.black.opacity(0.55))
                        .clipShape(Circle())
                }
                .padding(.top, 54).padding(.trailing, 20)
                .accessibilityLabel("关闭扫码")
            }
            .ignoresSafeArea()
        }
        .onOpenURL { connect($0.absoluteString) }
    }

    private func connect(_ value: String) {
        guard !connecting, let url = PairingLinkRules.validatedURL(value) else { return }
        linkFocused = false
        connecting = true
        Task {
            await model.bridge.pair(using: url)
            connecting = false
        }
    }

    private func userFacingPairingError(_ error: String) -> String {
        let normalized = error.lowercased()
        if normalized.contains("-34018") {
            return "无法安全保存配对信息，请安装已签名的 App 后重试。"
        }
        if normalized.contains("could not connect")
            || normalized.contains("couldn’t connect")
            || normalized.contains("connection refused") {
            return "无法连接 Mac，请确认 Zimlo Bridge 正在运行后重试。"
        }
        if normalized.contains("timed out") || normalized.contains("timeout") {
            return "连接 Mac 超时，请检查网络后重试。"
        }
        return error
    }
}

enum PairingLinkRules {
    static func validatedURL(_ value: String) -> URL? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              ["http", "https"].contains(scheme),
              let fragment = URLComponents(url: url, resolvingAgainstBaseURL: false)?.fragment else { return nil }
        let fields = URLComponents(string: "?\(fragment)")?.queryItems?
            .reduce(into: [String: String]()) { result, item in
                guard let value = item.value, !value.isEmpty else { return }
                result[item.name] = value
            } ?? [:]
        guard ["pairingId", "secret", "bridgeKey"].allSatisfy({ fields[$0] != nil }) else { return nil }
        return url
    }
}

private struct PairingButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(ZFont.callout.weight(.black))
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, minHeight: 44)
            .padding(.horizontal, 16).padding(.vertical, 8)
            .foregroundStyle(ZColor.onAccent.opacity(isEnabled ? 1 : 0.55))
            .background(ZColor.acid.opacity(isEnabled ? 1 : 0.36))
            .clipShape(RoundedRectangle(cornerRadius: ZRadius.inner, style: .continuous))
            .opacity(configuration.isPressed ? 0.72 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

private struct QRScannerView: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.onCode = onCode
        return controller
    }
    func updateUIViewController(_ uiViewController: ScannerController, context: Context) {}
}

@MainActor
private final class ScannerController: UIViewController {
    var onCode: ((String) -> Void)?
    private var worker: CaptureSessionWorker?
    private var preview: AVCaptureVideoPreviewLayer?
    private var errorPanel: UIView?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        let label = UILabel()
        label.text = "扫描 Mac 上的 Zimlo 配对二维码"
        label.textColor = UIColor(ZColor.ink)
        label.font = .boldSystemFont(ofSize: 16)
        label.textAlignment = .center
        label.numberOfLines = 0
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 22),
            label.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 68),
            label.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -68),
        ])

        let worker = CaptureSessionWorker(
            onConfigured: { [weak self] in self?.installPreview() },
            onFailure: { [weak self] message in
                self?.showCameraError(message, offersSettings: false)
            },
            onCode: { [weak self] value in self?.onCode?(value) }
        )
        self.worker = worker

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )
        prepareCameraAccess()
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        resumeCameraAfterAuthorizationChange()
        worker?.setRunning(true)
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        worker?.setRunning(false)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // 旋转时跟随最新 bounds，而不是 viewDidLoad 里写死的一帧。
        preview?.frame = view.bounds
        let angle: CGFloat
        switch view.window?.windowScene?.interfaceOrientation {
        case .landscapeLeft: angle = 180
        case .landscapeRight: angle = 0
        case .portraitUpsideDown: angle = 270
        default: angle = 90
        }
        if let connection = preview?.connection, connection.isVideoRotationAngleSupported(angle) {
            connection.videoRotationAngle = angle
        }
    }

    private func prepareCameraAccess() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            configureSession()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                Task { @MainActor in
                    guard let self else { return }
                    if granted {
                        self.configureSession()
                    } else {
                        self.showCameraError("未获得相机权限，请在系统设置中允许 Zimlo 使用相机。", offersSettings: true)
                    }
                }
            }
        case .denied, .restricted:
            showCameraError("相机权限已关闭，请在系统设置中允许 Zimlo 使用相机。", offersSettings: true)
        @unknown default:
            showCameraError("暂时无法使用相机，你仍可关闭扫码并粘贴配对链接。", offersSettings: false)
        }
    }

    private func configureSession() {
        worker?.configure()
    }

    private func installPreview() {
        guard preview == nil, let worker else { return }
        errorPanel?.removeFromSuperview()
        errorPanel = nil
        let preview = AVCaptureVideoPreviewLayer(session: worker.session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.bounds
        view.layer.insertSublayer(preview, at: 0)
        self.preview = preview
        view.setNeedsLayout()
    }

    private func showCameraError(_ message: String, offersSettings: Bool) {
        errorPanel?.removeFromSuperview()

        let messageLabel = UILabel()
        messageLabel.text = message
        messageLabel.textColor = UIColor(ZColor.ink)
        messageLabel.font = .preferredFont(forTextStyle: .body)
        messageLabel.textAlignment = .center
        messageLabel.numberOfLines = 0
        messageLabel.adjustsFontForContentSizeCategory = true

        let stack = UIStackView(arrangedSubviews: [messageLabel])
        stack.axis = .vertical
        stack.alignment = .fill
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false

        if offersSettings {
            let settingsButton = UIButton(type: .system)
            settingsButton.configuration = .filled()
            settingsButton.configuration?.title = "打开系统设置"
            settingsButton.configuration?.baseBackgroundColor = UIColor(ZColor.acid)
            settingsButton.configuration?.baseForegroundColor = UIColor(ZColor.onAccent)
            settingsButton.addTarget(self, action: #selector(openSettings), for: .touchUpInside)
            settingsButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
            stack.addArrangedSubview(settingsButton)
        }

        let panel = UIView()
        panel.backgroundColor = UIColor(ZColor.raised).withAlphaComponent(0.96)
        panel.layer.cornerRadius = 20
        panel.translatesAutoresizingMaskIntoConstraints = false
        panel.addSubview(stack)
        view.addSubview(panel)
        NSLayoutConstraint.activate([
            panel.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            panel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 28),
            panel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -28),
            stack.topAnchor.constraint(equalTo: panel.topAnchor, constant: 22),
            stack.leadingAnchor.constraint(equalTo: panel.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: panel.trailingAnchor, constant: -20),
            stack.bottomAnchor.constraint(equalTo: panel.bottomAnchor, constant: -22),
        ])
        errorPanel = panel
        UIAccessibility.post(notification: .announcement, argument: message)
    }

    @objc private func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    @objc private func appDidBecomeActive() {
        resumeCameraAfterAuthorizationChange()
    }

    private func resumeCameraAfterAuthorizationChange() {
        guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else { return }
        configureSession()
    }
}

/// Owns every mutable AVCaptureSession concern on one serial executor. UIKit
/// never crosses into this state; it only receives Sendable callbacks on the
/// main actor and installs a preview for the immutable session reference.
private final class CaptureSessionWorker: NSObject, AVCaptureMetadataOutputObjectsDelegate, @unchecked Sendable {
    let session = AVCaptureSession()

    private let queue = DispatchQueue(label: "app.zimlo.camera-session", qos: .userInitiated)
    private let onConfigured: @MainActor @Sendable () -> Void
    private let onFailure: @MainActor @Sendable (String) -> Void
    private let onCode: @MainActor @Sendable (String) -> Void
    private var configurationRequested = false
    private var isConfigured = false
    private var wantsSessionRunning = false
    private var didDeliverCode = false

    init(
        onConfigured: @escaping @MainActor @Sendable () -> Void,
        onFailure: @escaping @MainActor @Sendable (String) -> Void,
        onCode: @escaping @MainActor @Sendable (String) -> Void
    ) {
        self.onConfigured = onConfigured
        self.onFailure = onFailure
        self.onCode = onCode
    }

    func configure() {
        queue.async { [self] in
            guard !configurationRequested else { return }
            configurationRequested = true
            session.beginConfiguration()

            guard let device = AVCaptureDevice.default(for: .video) else {
                session.commitConfiguration()
                reportFailure("此设备没有可用的相机，你仍可关闭扫码并粘贴配对链接。")
                return
            }

            do {
                let input = try AVCaptureDeviceInput(device: device)
                guard session.canAddInput(input) else {
                    session.commitConfiguration()
                    reportFailure("相机初始化失败，请关闭扫码后重试。")
                    return
                }
                session.addInput(input)
            } catch {
                session.commitConfiguration()
                reportFailure("相机初始化失败，请关闭扫码后重试。")
                return
            }

            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else {
                session.commitConfiguration()
                reportFailure("当前相机无法扫描二维码，请改为粘贴配对链接。")
                return
            }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: queue)
            output.metadataObjectTypes = [.qr]
            session.commitConfiguration()
            isConfigured = true

            let callback = onConfigured
            Task { @MainActor in callback() }
            startSessionIfNeeded()
        }
    }

    func setRunning(_ running: Bool) {
        queue.async { [self] in
            wantsSessionRunning = running
            if running {
                startSessionIfNeeded()
            } else if session.isRunning {
                session.stopRunning()
            }
        }
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard !didDeliverCode,
              let value = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
        didDeliverCode = true
        wantsSessionRunning = false
        if session.isRunning { session.stopRunning() }
        let callback = onCode
        Task { @MainActor in callback(value) }
    }

    private func startSessionIfNeeded() {
        guard isConfigured, wantsSessionRunning, !session.isRunning else { return }
        session.startRunning()
    }

    private func reportFailure(_ message: String) {
        let callback = onFailure
        Task { @MainActor in callback(message) }
    }
}
