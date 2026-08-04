@preconcurrency import AVFoundation
import Foundation
@preconcurrency import Speech
@preconcurrency import WebKit

@MainActor
final class WebSpeechBridge: NSObject {
    static let messageHandlerName = "zimloSpeech"
    static let eventName = "zimlo:native-speech"

    private weak var webView: WKWebView?
    private let audioEngine = AVAudioEngine()
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var permissionTask: Task<Void, Never>?
    private var inputTapInstalled = false

    func attach(to webView: WKWebView) {
        self.webView = webView
    }

    func handle(_ message: WKScriptMessage) {
        guard message.name == Self.messageHandlerName,
              let body = message.body as? [String: Any],
              let type = body["type"] as? String else {
            return
        }

        switch type {
        case "start":
            let locale = body["locale"] as? String
            start(localeIdentifier: locale)
        case "stop":
            stop()
        default:
            break
        }
    }

    private func start(localeIdentifier: String?) {
        stop(notify: false)
        permissionTask?.cancel()
        permissionTask = Task { [weak self] in
            let speechAuthorization = await Self.speechAuthorization()
            guard !Task.isCancelled else { return }
            guard speechAuthorization == .authorized else {
                self?.emitError("请在系统设置中允许 Zimlo 使用语音识别")
                return
            }

            let microphoneAuthorized = await Self.microphoneAuthorization()
            guard !Task.isCancelled else { return }
            guard microphoneAuthorized else {
                self?.emitError("请在系统设置中允许 Zimlo 使用麦克风")
                return
            }

            self?.beginRecognition(localeIdentifier: localeIdentifier)
        }
    }

    private func beginRecognition(localeIdentifier: String?) {
        let preferredLocale = localeIdentifier?.trimmingCharacters(in: .whitespacesAndNewlines)
        let locale = Locale(identifier: preferredLocale.flatMap { $0.isEmpty ? nil : $0 } ?? "zh-CN")
        guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.isAvailable else {
            emitError("当前无法启动语音输入，文字草稿仍在")
            return
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        recognitionRequest = request

        let inputNode = audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            recognitionRequest = nil
            emitError("没有检测到可用的麦克风")
            return
        }

        inputNode.installTap(onBus: 0, bufferSize: 1_024, format: format) { buffer, when in
            request.append(buffer)
        }
        inputTapInstalled = true

        do {
            audioEngine.prepare()
            try audioEngine.start()
        } catch {
            removeInputTap()
            recognitionRequest = nil
            emitError("无法启动麦克风，文字草稿仍在")
            return
        }

        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor [weak self] in
                self?.receive(result: result, error: error)
            }
        }
        emit(["type": "state", "recording": true])
    }

    private func receive(result: SFSpeechRecognitionResult?, error: Error?) {
        guard recognitionTask != nil else { return }

        if let result {
            emit([
                "type": "result",
                "text": result.bestTranscription.formattedString,
            ])
            if result.isFinal {
                stop()
                return
            }
        }

        if error != nil {
            stop(notify: false)
            emitError("语音输入失败，文字草稿仍在")
        }
    }

    func stop(notify: Bool = true) {
        permissionTask?.cancel()
        permissionTask = nil

        let wasActive = recognitionTask != nil || recognitionRequest != nil || audioEngine.isRunning
        if audioEngine.isRunning {
            audioEngine.stop()
        }
        removeInputTap()
        recognitionRequest?.endAudio()
        recognitionRequest = nil
        let task = recognitionTask
        recognitionTask = nil
        task?.cancel()

        if notify, wasActive {
            emit(["type": "state", "recording": false])
        }
    }

    private func removeInputTap() {
        guard inputTapInstalled else { return }
        audioEngine.inputNode.removeTap(onBus: 0)
        inputTapInstalled = false
    }

    private func emitError(_ message: String) {
        stop(notify: false)
        emit(["type": "error", "message": message])
        emit(["type": "state", "recording": false])
    }

    private func emit(_ payload: [String: Any]) {
        guard let script = WebSpeechEventScript.make(
            payload: payload,
            eventName: Self.eventName
        ), let webView else {
            return
        }
        webView.evaluateJavaScript(script)
    }

    private nonisolated static func speechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        let current = SFSpeechRecognizer.authorizationStatus()
        guard current == .notDetermined else { return current }
        return await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }
    }

    private nonisolated static func microphoneAuthorization() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            return true
        case .notDetermined:
            return await AVCaptureDevice.requestAccess(for: .audio)
        case .denied, .restricted:
            return false
        @unknown default:
            return false
        }
    }
}

enum WebSpeechEventScript {
    static func make(payload: [String: Any], eventName: String) -> String? {
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload) else {
            return nil
        }
        let base64 = data.base64EncodedString()
        return """
            (() => {
              const binary = atob('\(base64)');
              const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
              const detail = JSON.parse(new TextDecoder('utf-8').decode(bytes));
              window.dispatchEvent(new CustomEvent('\(eventName)', { detail }));
            })();
            """
    }
}
