import AVFoundation
import Speech
import SwiftUI

@MainActor
final class SpeechCapture: ObservableObject {
    @Published var recording = false
    @Published var error: String?

    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    func toggle(onText: @escaping (String) -> Void) {
        if recording { stop(); return }
        Task {
            let status = await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
            }
            guard status == .authorized else {
                error = "请在系统设置中允许语音识别"
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
                if error != nil || result?.isFinal == true { self?.stop() }
            }
        }
    }
}

struct VoiceInput: View {
    @Binding var text: String
    var placeholder: String
    var axis: Axis = .vertical
    @StateObject private var speech = SpeechCapture()
    @State private var baseText = ""

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField(placeholder, text: $text, axis: axis)
                .lineLimit(axis == .vertical ? 1...5 : 1...1)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(ZColor.ink)
                .padding(.horizontal, 14).padding(.vertical, 12)
                .background(Color.white.opacity(0.72))
                .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
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
    }
}
