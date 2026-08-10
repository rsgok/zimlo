@preconcurrency import AVFoundation
import Combine
import Foundation
@preconcurrency import Speech

@MainActor
final class NativeSpeechRecognizer: ObservableObject {
    enum State: Equatable {
        case idle
        case listening
        case failed(String)
    }

    @Published private(set) var state: State = .idle
    @Published private(set) var transcript = ""

    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))
    private let audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    var isListening: Bool { state == .listening }

    func toggle() async {
        if isListening { stop(); return }
        await start()
    }

    func start() async {
        stop()
        do {
            try await authorize()
            try beginRecognition()
            state = .listening
        } catch {
            stop()
            state = .failed(error.localizedDescription)
        }
    }

    func stop() {
        if audioEngine.isRunning { audioEngine.stop() }
        audioEngine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        if state == .listening { state = .idle }
    }

    private func authorize() async throws {
        let speech = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard speech == .authorized else {
            throw SpeechIssue.message("请在系统设置中允许 Zimlo 使用语音识别。")
        }
        let microphone = await AVCaptureDevice.requestAccess(for: .audio)
        guard microphone else {
            throw SpeechIssue.message("请在系统设置中允许 Zimlo 使用麦克风。")
        }
        guard recognizer?.isAvailable == true else {
            throw SpeechIssue.message("语音识别服务暂时不可用，请稍后重试。")
        }
    }

    private func beginRecognition() throws {
        transcript = ""
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        self.request = request

        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw SpeechIssue.message("没有检测到可用的麦克风输入。")
        }
        input.installTap(onBus: 0, bufferSize: 1_024, format: format) { buffer, _ in
            request.append(buffer)
        }
        audioEngine.prepare()
        try audioEngine.start()
        task = recognizer?.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                guard let self else { return }
                if let result {
                    self.transcript = result.bestTranscription.formattedString
                    if result.isFinal { self.stop() }
                }
                if let error, self.transcript.isEmpty {
                    self.stop()
                    self.state = .failed(error.localizedDescription)
                }
            }
        }
    }
}

private enum SpeechIssue: LocalizedError {
    case message(String)
    var errorDescription: String? {
        if case .message(let message) = self { return message }
        return nil
    }
}
