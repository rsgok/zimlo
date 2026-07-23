import CryptoKit
import Foundation
import UIKit

@MainActor
final class BridgeClient: ObservableObject {
    @Published private(set) var connected = false
    @Published private(set) var pairingRequired = KeychainStore.load() == nil
    @Published private(set) var error: String?

    var onMessage: ((ServerEnvelope) -> Void)?
    var onSecureConnection: (() -> Void)?

    private var socket: URLSessionWebSocketTask?
    private var reconnectTask: Task<Void, Never>?
    private var startupTask: Task<Void, Never>?
    private var credentials: DeviceCredentials?
    private var clientTX: Data?
    private var serverTX: Data?
    private var sendCounter: UInt64 = 0
    private var receiveCounter: UInt64 = 0
    private var intentionallyStopped = false

    func start() {
        intentionallyStopped = false
        guard socket == nil, !connected, startupTask == nil else { return }
        guard let credentials = KeychainStore.load() else {
            pairingRequired = true
            return
        }
        self.credentials = credentials
        pairingRequired = false
        startupTask = Task {
            defer { startupTask = nil }
            do {
                try await verifyProtocol(at: credentials.bridgeURL)
                guard !Task.isCancelled else { return }
                connect()
            } catch {
                if !Task.isCancelled { self.error = error.localizedDescription }
            }
        }
    }

    func stop() {
        intentionallyStopped = true
        startupTask?.cancel()
        startupTask = nil
        reconnectTask?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        connected = false
    }

    func forgetDevice() {
        stop()
        KeychainStore.clear()
        credentials = nil
        pairingRequired = true
        error = nil
    }

    func pair(using pairingURL: URL) async {
        do {
            let credentials = try await performPairing(pairingURL)
            try KeychainStore.save(credentials)
            self.credentials = credentials
            pairingRequired = false
            error = nil
            connect()
        } catch {
            self.error = error.localizedDescription
        }
    }

    func send(_ command: ClientCommand) -> Bool {
        guard connected, let socket, let key = clientTX, let credentials else { return false }
        do {
            let plaintext = try JSONEncoder().encode(command)
            let counter = sendCounter
            sendCounter += 1
            let ciphertext = try ZimloCrypto.encrypt(
                key: key,
                counter: counter,
                value: plaintext,
                aad: "zimlo-ws-v1:\(credentials.deviceId)"
            )
            let frame = SecureFrame(type: "secure", counter: counter, ciphertext: ciphertext)
            let data = try JSONEncoder().encode(frame)
            socket.send(.string(String(decoding: data, as: UTF8.self))) { [weak self] error in
                if let error {
                    Task { @MainActor in self?.fail(error) }
                }
            }
            return true
        } catch {
            fail(error)
            return false
        }
    }

    private func connect() {
        guard let credentials else { return }
        socket?.cancel()
        clientTX = nil
        serverTX = nil
        sendCounter = 0
        receiveCounter = 0
        var components = URLComponents(url: credentials.bridgeURL, resolvingAgainstBaseURL: false)
        components?.scheme = credentials.bridgeURL.scheme == "https" ? "wss" : "ws"
        components?.path = "/ws"
        components?.query = nil
        components?.fragment = nil
        guard let url = components?.url else {
            error = "Bridge 地址无效"
            return
        }
        let socket = URLSession.shared.webSocketTask(with: url)
        self.socket = socket
        socket.resume()
        Task { [weak self] in await self?.authenticate(credentials: credentials) }
    }

    private func authenticate(credentials: DeviceCredentials) async {
        guard let socket, let deviceKey = ZimloCrypto.fromBase64URL(credentials.deviceKey) else {
            fail(ZimloCryptoError.invalidKey)
            return
        }
        do {
            let clientNonce = ZimloCrypto.randomBytes(count: 24)
            let clientNonceText = ZimloCrypto.base64URL(clientNonce)
            let auth = AuthRequest(
                type: "auth",
                deviceId: credentials.deviceId,
                clientNonce: clientNonceText,
                proof: ZimloCrypto.proof(key: deviceKey, message: "ws:\(clientNonceText)")
            )
            try await socket.send(.data(JSONEncoder().encode(auth)))
            let message = try await socket.receive()
            let data = try data(from: message)
            let response = try JSONDecoder().decode(AuthResponse.self, from: data)
            guard response.type == "auth.ok",
                  ZimloCrypto.verifyProof(
                    key: deviceKey,
                    message: "ws-server:\(clientNonceText):\(response.serverNonce)",
                    proof: response.proof
                  ),
                  let serverNonce = ZimloCrypto.fromBase64URL(response.serverNonce) else {
                throw ZimloCryptoError.invalidProof
            }
            let keys = ZimloCrypto.connectionKeys(deviceKey: deviceKey, clientNonce: clientNonce, serverNonce: serverNonce)
            clientTX = keys.client
            serverTX = keys.server
            connected = true
            error = nil
            onSecureConnection?()
            await receiveLoop()
        } catch {
            fail(error)
        }
    }

    private func receiveLoop() async {
        guard let socket else { return }
        do {
            while !Task.isCancelled {
                let message = try await socket.receive()
                let frame = try JSONDecoder().decode(SecureFrame.self, from: data(from: message))
                guard frame.type == "secure", frame.counter == receiveCounter,
                      let serverTX, let credentials else { throw ZimloCryptoError.invalidCounter }
                let plaintext = try ZimloCrypto.decrypt(
                    key: serverTX,
                    counter: frame.counter,
                    ciphertext: frame.ciphertext,
                    aad: "zimlo-ws-v1:\(credentials.deviceId)"
                )
                receiveCounter += 1
                onMessage?(try JSONDecoder().decode(ServerEnvelope.self, from: plaintext))
            }
        } catch {
            fail(error)
        }
    }

    private func fail(_ failure: Error) {
        connected = false
        error = failure.localizedDescription
        if socket?.closeCode == .policyViolation {
            socket = nil
            KeychainStore.clear()
            credentials = nil
            pairingRequired = true
            intentionallyStopped = true
            error = "设备身份已失效或被撤销，请重新配对"
            return
        }
        socket?.cancel()
        socket = nil
        guard !intentionallyStopped, credentials != nil else { return }
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1.5))
            guard !Task.isCancelled else { return }
            self?.connect()
        }
    }

    private func performPairing(_ url: URL) async throws -> DeviceCredentials {
        guard let scheme = url.scheme, ["http", "https"].contains(scheme),
              var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let fragment = components.fragment else {
            throw PairingError.invalidLink
        }
        let values = URLComponents(string: "?\(fragment)")?.queryItems?
            .reduce(into: [String: String]()) { $0[$1.name] = $1.value } ?? [:]
        guard let pairingId = values["pairingId"],
              let secret = values["secret"].flatMap(ZimloCrypto.fromBase64URL),
              let bridgeKey = values["bridgeKey"].flatMap(ZimloCrypto.fromBase64URL) else {
            throw PairingError.invalidLink
        }
        components.path = ""
        components.query = nil
        components.fragment = nil
        guard let bridgeURL = components.url else { throw PairingError.invalidLink }
        try await verifyProtocol(at: bridgeURL)

        let pair = Curve25519.KeyAgreement.PrivateKey()
        let pairKey = try ZimloCrypto.pairKey(privateKey: pair, peerPublicKey: bridgeKey, secret: secret)
        var pairEndpoint = components
        pairEndpoint.path = "/api/pair"
        guard let endpoint = pairEndpoint.url else { throw PairingError.invalidLink }
        let body = PairRequest(
            pairingId: pairingId,
            clientPublicKey: ZimloCrypto.base64URL(pair.publicKey.rawRepresentation),
            proof: ZimloCrypto.proof(key: pairKey, message: "client:\(pairingId)"),
            name: UIDevice.current.name
        )
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw PairingError.expired
        }
        let result = try JSONDecoder().decode(PairResponse.self, from: data)
        guard ZimloCrypto.verifyProof(key: pairKey, message: "server:\(result.deviceId)", proof: result.serverProof) else {
            throw ZimloCryptoError.invalidProof
        }
        return DeviceCredentials(
            bridgeURL: bridgeURL,
            deviceId: result.deviceId,
            deviceKey: ZimloCrypto.base64URL(ZimloCrypto.deviceKey(pairKey: pairKey, secret: secret))
        )
    }

    private func verifyProtocol(at bridgeURL: URL) async throws {
        var components = URLComponents(url: bridgeURL, resolvingAgainstBaseURL: false)
        components?.path = "/healthz"
        guard let url = components?.url else { throw PairingError.invalidLink }
        let (data, response) = try await URLSession.shared.data(from: url)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200,
              let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              value["protocolVersion"] as? Int == 2 else {
            throw PairingError.incompatibleVersion
        }
    }

    private func data(from message: URLSessionWebSocketTask.Message) throws -> Data {
        switch message {
        case .data(let data): return data
        case .string(let text): return Data(text.utf8)
        @unknown default: throw PairingError.invalidResponse
        }
    }
}

private enum PairingError: LocalizedError {
    case invalidLink
    case expired
    case invalidResponse
    case incompatibleVersion

    var errorDescription: String? {
        switch self {
        case .invalidLink: "这不是有效的 Zimlo 配对链接"
        case .expired: "配对链接已过期、已使用或校验失败，请在 Mac 上重新生成"
        case .invalidResponse: "Bridge 返回了无法识别的响应"
        case .incompatibleVersion: "Mac 上的 Zimlo Bridge 版本不兼容，请先升级"
        }
    }
}

private struct PairRequest: Codable {
    var pairingId: String
    var clientPublicKey: String
    var proof: String
    var name: String
}

private struct PairResponse: Codable {
    var deviceId: String
    var serverProof: String
}

private struct AuthRequest: Codable {
    var type: String
    var deviceId: String
    var clientNonce: String
    var proof: String
}

private struct AuthResponse: Codable {
    var type: String
    var serverNonce: String
    var proof: String
}

private struct SecureFrame: Codable {
    var type: String
    var counter: UInt64
    var ciphertext: String
}
