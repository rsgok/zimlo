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

    private lazy var recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))
    private let makeAudioEngine: () -> AVAudioEngine
    private var audioEngine: AVAudioEngine?
    private var tappedInput: AVAudioInputNode?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var generation = UUID()

    init(makeAudioEngine: @escaping () -> AVAudioEngine = { AVAudioEngine() }) {
        self.makeAudioEngine = makeAudioEngine
    }

    var isListening: Bool { state == .listening }

    func toggle() async {
        if isListening { stop(); return }
        await start()
    }

    func start() async {
        stop()
        let current = generation
        do {
            try await authorize()
            guard current == generation else { return }
            try beginRecognition(generation: current)
            state = .listening
        } catch {
            guard current == generation else { return }
            stop()
            state = .failed(error.localizedDescription)
        }
    }

    func stop() {
        generation = UUID()
        // Closing a text-only composer must not initialize microphone hardware.
        // Resolving inputNode here can block AppKit while CoreAudio opens a device.
        if audioEngine?.isRunning == true { audioEngine?.stop() }
        tappedInput?.removeTap(onBus: 0)
        tappedInput = nil
        audioEngine = nil
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

    private func beginRecognition(generation current: UUID) throws {
        transcript = ""
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        self.request = request

        let audioEngine = makeAudioEngine()
        self.audioEngine = audioEngine
        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw SpeechIssue.message("没有检测到可用的麦克风输入。")
        }
        input.installTap(onBus: 0, bufferSize: 1_024, format: format) { buffer, _ in
            request.append(buffer)
        }
        tappedInput = input
        audioEngine.prepare()
        try audioEngine.start()
        task = recognizer?.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                guard let self, self.generation == current else { return }
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
