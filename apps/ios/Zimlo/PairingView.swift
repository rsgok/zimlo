import AVFoundation
import SwiftUI

struct PairingView: View {
    @ObservedObject var model: AppModel
    @State private var link = ""
    @State private var scanning = false

    var body: some View {
        VStack(spacing: 22) {
            Spacer()
            ZimloAvatar(size: 72)
            VStack(spacing: 7) {
                Text("连接你的 Mac").font(ZFont.title)
                Text("在 Mac 上生成二维码后直接扫描。无需连接同一个 Wi-Fi，密钥只保存在你的设备上。")
                    .font(ZFont.subheadline).foregroundStyle(.white.opacity(0.58))
                    .multilineTextAlignment(.center).lineSpacing(3)
            }
            Button {
                scanning = true
            } label: {
                Label("扫描配对二维码", systemImage: "qrcode.viewfinder")
            }
            .buttonStyle(PairingButtonStyle())
            HStack {
                Rectangle().fill(.white.opacity(0.16)).frame(height: 1)
                Text("或粘贴配对链接").font(ZFont.caption2).foregroundStyle(.white.opacity(0.42))
                Rectangle().fill(.white.opacity(0.16)).frame(height: 1)
            }
            TextField("粘贴 Zimlo 配对链接", text: $link)
                .textInputAutocapitalization(.never).keyboardType(.URL)
                .font(.footnote.monospaced())
                .padding(14).background(.white.opacity(0.09)).clipShape(RoundedRectangle(cornerRadius: ZRadius.control))
            Button("连接") { connect(link) }
                .buttonStyle(PairingButtonStyle())
                .disabled(URL(string: link) == nil)
            if let error = model.bridge.error {
                Text(error).font(ZFont.footnote.weight(.semibold)).foregroundStyle(ZColor.coral).multilineTextAlignment(.center)
            }
            Spacer()
            Text("任务内容端到端加密 · 云端只负责连接设备")
                .font(ZFont.caption2).foregroundStyle(.white.opacity(0.38))
        }
        .padding(.horizontal, 28).padding(.vertical, 30)
        .foregroundStyle(.white).background(ZColor.ink)
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
                        .foregroundStyle(.white)
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
        guard let url = URL(string: value.trimmingCharacters(in: .whitespacesAndNewlines)) else { return }
        Task { await model.bridge.pair(using: url) }
    }
}

private struct PairingButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(ZFont.callout.weight(.black))
            .frame(maxWidth: .infinity).padding(.vertical, 14)
            .foregroundStyle(ZColor.ink).background(ZColor.acid)
            .clipShape(RoundedRectangle(cornerRadius: ZRadius.inner, style: .continuous))
            .opacity(configuration.isPressed ? 0.72 : 1)
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

private final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?
    private let session = AVCaptureSession()
    private var preview: AVCaptureVideoPreviewLayer?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else { return }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.bounds
        view.layer.addSublayer(preview)
        self.preview = preview
        let label = UILabel()
        label.text = "扫描 Mac 上的 Zimlo 配对二维码"
        label.textColor = .white
        label.font = .boldSystemFont(ofSize: 16)
        label.textAlignment = .center
        label.autoresizingMask = [.flexibleLeftMargin, .flexibleRightMargin, .flexibleBottomMargin]
        label.frame = CGRect(x: 24, y: 70, width: view.bounds.width - 48, height: 40)
        view.addSubview(label)
        DispatchQueue.global(qos: .userInitiated).async { [session] in session.startRunning() }
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

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard let value = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
        session.stopRunning()
        onCode?(value)
    }
}
