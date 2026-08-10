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
    private var authorizationTask: Task<Void, Never>?
    private var tapInstalled = false
    private var audioSessionActive = false

    private enum CaptureError: LocalizedError {
        case recognizerUnavailable
        case audioInputUnavailable

        var errorDescription: String? {
            switch self {
            case .recognizerUnavailable:
                return "语音识别暂时不可用，请稍后重试"
            case .audioInputUnavailable:
                return SpeechCaptureErrorRules.audioInputUnavailableMessage(isSimulator: Self.isSimulator)
            }
        }

        private static var isSimulator: Bool {
#if targetEnvironment(simulator)
            true
#else
            false
#endif
        }
    }

    func toggle(onText: @escaping (String) -> Void) {
        error = nil
        if recording { stop(); return }
        authorizationTask?.cancel()
        authorizationTask = Task { [weak self] in
            let status = await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
            }
            guard !Task.isCancelled, let self else { return }
            self.authorizationTask = nil
            guard status == .authorized else {
                self.error = "语音识别权限未开启，请在系统设置中允许"
                return
            }
            let microphoneAllowed = await withCheckedContinuation { continuation in
                AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
            }
            guard !Task.isCancelled else { return }
            guard microphoneAllowed else {
                self.error = "麦克风权限未开启，请在系统设置中允许"
                return
            }
            do { try self.start(onText: onText) }
            catch {
                let message = self.userFacingMessage(for: error)
                self.stop()
                self.error = message
            }
        }
    }

    func stop() {
        authorizationTask?.cancel()
        authorizationTask = nil
        engine.stop()
        if tapInstalled {
            engine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        recording = false
        if audioSessionActive {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            audioSessionActive = false
        }
    }

    private func start(onText: @escaping (String) -> Void) throws {
        guard let recognizer, recognizer.isAvailable else {
            throw CaptureError.recognizerUnavailable
        }
        task?.cancel()
        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(.record, mode: .measurement, options: .duckOthers)
        try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
        audioSessionActive = true
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        // Simulator 可能报告支持端上识别，却没有可用模型；真机继续优先端上。
#if !targetEnvironment(simulator)
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
#endif
        self.request = request
        let node = engine.inputNode
        let format = node.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw CaptureError.audioInputUnavailable
        }
        node.installTap(onBus: 0, bufferSize: 1_024, format: format) { buffer, _ in request.append(buffer) }
        tapInstalled = true
        engine.prepare()
        try engine.start()
        recording = true
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                if let text = result?.bestTranscription.formattedString { onText(text) }
                if let error {
                    self?.error = self?.userFacingMessage(for: error)
                    self?.stop()
                } else if result?.isFinal == true {
                    self?.stop()
                }
            }
        }
    }

    private func userFacingMessage(for error: Error) -> String {
#if targetEnvironment(simulator)
        let isSimulator = true
#else
        let isSimulator = false
#endif
        return SpeechCaptureErrorRules.message(for: error.localizedDescription, isSimulator: isSimulator)
    }
}

enum SpeechCaptureErrorRules {
    static func audioInputUnavailableMessage(isSimulator: Bool) -> String {
        if isSimulator {
            return "模拟器没有可用的麦克风输入。请在 Simulator 的 I/O → Audio Input 中选择 Mac 麦克风，或使用真机测试。"
        }
        return "当前没有可用的麦克风输入，请检查麦克风权限后重试"
    }

    static func message(for systemMessage: String, isSimulator: Bool) -> String {
        let normalized = systemMessage.lowercased()
        if normalized.contains("failed to initialize recognizer")
            || normalized.contains("audio input")
            || normalized.contains("input format") {
            return isSimulator
                ? "模拟器无法启动语音识别。请在 Simulator 的 I/O → Audio Input 中选择 Mac 麦克风，或使用真机测试。"
                : "语音识别启动失败，请检查麦克风和网络后重试"
        }
        return systemMessage.isEmpty ? "语音识别暂时不可用，请稍后重试" : systemMessage
    }
}

struct VoiceInput: View {
    @Binding var text: String
    var placeholder: String
    var axis: Axis = .vertical
    var minHeight: CGFloat? = nil
    var onError: ((String) -> Void)? = nil
    @StateObject private var speech = SpeechCapture()
    @State private var baseText = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 8) {
                // 识别期间保持可手动编辑：语音结果追加到已有文本之后。
                TextField(placeholder, text: $text, axis: axis)
                    .lineLimit(axis == .vertical ? 1...5 : 1...1)
                    .font(ZFont.callout)
                    .foregroundStyle(ZColor.ink)
                    .padding(.horizontal, 14).padding(.vertical, 12)
                    .frame(minHeight: minHeight, alignment: .topLeading)
                    .background(ZColor.control)
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
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
                .accessibilityLabel(speech.recording ? "停止语音输入" : "开始语音输入")
            }
            // 权限拒绝 / 识别失败就地提示，不再静默。
            if onError == nil, let error = speech.error {
                Text(error)
                    .font(ZFont.caption2)
                    .foregroundStyle(ZColor.coralText)
            }
        }
        .onChange(of: speech.error) { _, error in
            if let error { onError?(error) }
        }
        .onDisappear {
            // 离开输入页时同步停止识别并归还录音 session，避免后台残留占用麦克风。
            speech.stop()
        }
    }
}
