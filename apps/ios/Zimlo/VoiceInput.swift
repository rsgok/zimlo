import AVFoundation
import Speech
import SwiftUI

@MainActor
final class SpeechCapture: ObservableObject {
    @Published var recording = false
    @Published var error: String?

    // 跟随系统语言，不再写死 zh-CN。
    private let recognizer = SFSpeechRecognizer(locale: .autoupdatingCurrent)
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    func toggle(onText: @escaping (String) -> Void) {
        error = nil
        if recording { stop(); return }
        Task {
            let status = await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
            }
            guard status == .authorized else {
                error = "语音识别权限未开启，请在系统设置中允许"
                return
            }
            do { try start(onText: onText) }
            catch { self.error = error.localizedDescription }
        }
    }

    func stop() {
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        recording = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func start(onText: @escaping (String) -> Void) throws {
        task?.cancel()
        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(.record, mode: .measurement, options: .duckOthers)
        try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        // 优先端上识别；设备不支持时退回默认（云端）识别。
        if recognizer?.supportsOnDeviceRecognition == true {
            request.requiresOnDeviceRecognition = true
        }
        self.request = request
        let node = engine.inputNode
        let format = node.outputFormat(forBus: 0)
        node.installTap(onBus: 0, bufferSize: 1_024, format: format) { buffer, _ in request.append(buffer) }
        engine.prepare()
        try engine.start()
        recording = true
        task = recognizer?.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                if let text = result?.bestTranscription.formattedString { onText(text) }
                if let error {
                    self?.error = error.localizedDescription
                    self?.stop()
                } else if result?.isFinal == true {
                    self?.stop()
                }
            }
        }
    }
}

struct VoiceInput: View {
    @Binding var text: String
    var placeholder: String
    var axis: Axis = .vertical
    var minHeight: CGFloat? = nil
    @StateObject private var speech = SpeechCapture()
    @State private var baseText = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .bottom, spacing: 8) {
                // 识别期间保持可手动编辑：语音结果追加到已有文本之后。
                TextField(placeholder, text: $text, axis: axis)
                    .lineLimit(axis == .vertical ? 1...5 : 1...1)
                    .font(ZFont.callout)
                    .foregroundStyle(ZColor.ink)
                    .padding(.horizontal, 14).padding(.vertical, 12)
                    .frame(minHeight: minHeight, alignment: .topLeading)
                    .background(Color.white.opacity(0.72))
                    .clipShape(RoundedRectangle(cornerRadius: ZRadius.inner, style: .continuous))
                Button {
                    baseText = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    speech.toggle { spoken in
                        text = [baseText, spoken].filter { !$0.isEmpty }.joined(separator: baseText.isEmpty ? "" : " ")
                    }
                } label: {
                    Image(systemName: speech.recording ? "waveform.circle.fill" : "mic.circle.fill")
                        .font(.system(size: 34))
                        .foregroundStyle(speech.recording ? ZColor.coral : ZColor.ink)
                }
                .accessibilityLabel(speech.recording ? "停止语音输入" : "开始语音输入")
            }
            // 权限拒绝 / 识别失败就地提示，不再静默。
            if let error = speech.error {
                Text(error)
                    .font(ZFont.caption2)
                    .foregroundStyle(ZColor.coral)
            }
        }
    }
}
