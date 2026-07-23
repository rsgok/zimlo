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
                Text("连接你的 Mac").font(.system(size: 30, weight: .black, design: .rounded))
                Text("在 Mac 上生成配对二维码，然后用这台 iPhone 扫描。密钥只保存在本机钥匙串。")
                    .font(.system(size: 14, weight: .medium)).foregroundStyle(.white.opacity(0.58))
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
                Text("或粘贴配对链接").font(.caption.bold()).foregroundStyle(.white.opacity(0.42))
                Rectangle().fill(.white.opacity(0.16)).frame(height: 1)
            }
            TextField("http://Mac-IP:4747/#pairingId=…", text: $link)
                .textInputAutocapitalization(.never).keyboardType(.URL)
                .font(.system(size: 13, design: .monospaced))
                .padding(14).background(.white.opacity(0.09)).clipShape(RoundedRectangle(cornerRadius: 14))
            Button("连接") { connect(link) }
                .buttonStyle(PairingButtonStyle())
                .disabled(URL(string: link) == nil)
            if let error = model.bridge.error {
                Text(error).font(.system(size: 12, weight: .semibold)).foregroundStyle(ZColor.coral).multilineTextAlignment(.center)
            }
            Spacer()
            Text("Zimlo 不经过公网 Relay · 仅连接你的可信 LAN / VPN")
                .font(.system(size: 10, weight: .semibold)).foregroundStyle(.white.opacity(0.38))
        }
        .padding(.horizontal, 28).padding(.vertical, 30)
        .foregroundStyle(.white).background(ZColor.ink)
        .sheet(isPresented: $scanning) {
            QRScannerView { value in
                scanning = false
                link = value
                connect(value)
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
            .font(.system(size: 15, weight: .black))
            .frame(maxWidth: .infinity).padding(.vertical, 14)
            .foregroundStyle(ZColor.ink).background(ZColor.acid)
            .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
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
        let label = UILabel()
        label.text = "扫描 Mac 上的 Zimlo 配对二维码"
        label.textColor = .white
        label.font = .boldSystemFont(ofSize: 16)
        label.textAlignment = .center
        label.frame = CGRect(x: 24, y: 70, width: view.bounds.width - 48, height: 40)
        view.addSubview(label)
        DispatchQueue.global(qos: .userInitiated).async { [session] in session.startRunning() }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard let value = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
        session.stopRunning()
        onCode?(value)
    }
}
