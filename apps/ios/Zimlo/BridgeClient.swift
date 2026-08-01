import CryptoKit
import Foundation
import Network
import UIKit

@MainActor
final class BridgeClient: ObservableObject {
    @Published private(set) var connected = false
    @Published private(set) var pairingRequired = KeychainStore.load() == nil
    @Published private(set) var error: String?
    @Published private(set) var connectionMode = "offline"

    var onMessage: ((ServerEnvelope) -> Void)?
    var onSecureConnection: (() -> Void)?
    // 可注入随机源，测试退避序列时固定。
    var backoffRandom: () -> Double = { Double.random(in: 0..<1) }

    private var socket: URLSessionWebSocketTask?
    private var connectionTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var startupTask: Task<Void, Never>?
    private var startupGeneration: UInt64?
    private var connectionGeneration: UInt64 = 0
    private var credentials: DeviceCredentials?
    private var clientTX: Data?
    private var serverTX: Data?
    private var sendCounter: UInt64 = 0
    private var receiveCounter: UInt64 = 0
    private var intentionallyStopped = false
    private var usingRemoteRelay = false
    private var retryRemoteNext = false
    private var reconnectAttempt = 0
    private var networkMonitor: NWPathMonitor?
    private var networkAvailable = true

    func start() {
        intentionallyStopped = false
        reconnectAttempt = 0
        startNetworkMonitor()
        guard socket == nil, !connected, startupTask == nil else { return }
        guard let credentials = KeychainStore.load() else {
            pairingRequired = true
            return
        }
        self.credentials = credentials
        pairingRequired = false
        let generation = beginConnectionGeneration()
        startupGeneration = generation
        startupTask = Task { [weak self] in
            guard let self else { return }
            defer { self.finishStartup(generation: generation) }
            do {
                try await verifyProtocol(at: credentials.bridgeURL)
                guard !Task.isCancelled, self.accepts(generation: generation) else { return }
                self.connect(remote: self.prefersRemote(credentials), expectedGeneration: generation)
            } catch {
                guard !Task.isCancelled, self.accepts(generation: generation) else { return }
                if credentials.remoteRelayURL != nil, credentials.remoteAccessToken != nil {
                    self.connect(remote: true, expectedGeneration: generation)
                } else {
                    self.error = error.localizedDescription
                }
            }
        }
    }

    // 手动重试：清掉等待中的退避，立即按初始序列重连（离线/重连胶囊可点触发）。
    func retryNow() {
        guard !connected, credentials != nil else { return }
        intentionallyStopped = false
        reconnectAttempt = 0
        reconnectTask?.cancel()
        startupTask?.cancel()
        startupGeneration = nil
        startupTask = nil
        invalidateConnection(closeCode: .goingAway)
        start()
    }

    private func startNetworkMonitor() {
        guard networkMonitor == nil else { return }
        let monitor = NWPathMonitor()
        networkMonitor = monitor
        monitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor in
                guard let self else { return }
                let available = path.status == .satisfied
                let wasDown = !self.networkAvailable
                self.networkAvailable = available
                if !available {
                    // 系统离线：暂停重连循环，避免空耗与抖动计时。
                    self.reconnectTask?.cancel()
                } else if wasDown, !self.connected, !self.intentionallyStopped, self.credentials != nil {
                    self.retryNow()
                }
            }
        }
        monitor.start(queue: .main)
    }

    func stop() {
        intentionallyStopped = true
        startupTask?.cancel()
        startupGeneration = nil
        startupTask = nil
        reconnectTask?.cancel()
        reconnectTask = nil
        invalidateConnection(closeCode: .goingAway)
        connected = false
        connectionMode = "offline"
    }

    func forgetDevice() {
        stop()
        KeychainStore.clear()
        credentials = nil
        pairingRequired = true
        error = nil
    }

    func pair(using pairingURL: URL) async {
        intentionallyStopped = false
        error = nil
        startupTask?.cancel()
        startupTask = nil
        startupGeneration = nil
        reconnectTask?.cancel()
        reconnectTask = nil
        let generation = beginConnectionGeneration(closeCode: .goingAway)
        connected = false
        connectionMode = "offline"
        do {
            let credentials = try await performPairing(pairingURL)
            guard accepts(generation: generation) else { return }
            try KeychainStore.save(credentials)
            guard accepts(generation: generation) else { return }
            self.credentials = credentials
            pairingRequired = false
            error = nil
            connect(remote: prefersRemote(credentials), expectedGeneration: generation)
        } catch {
            guard accepts(generation: generation) else { return }
            self.error = error.localizedDescription
        }
    }

    func send(_ command: ClientCommand) -> Bool {
        guard connected, let socket, let key = clientTX, let credentials else { return false }
        let generation = connectionGeneration
        let remote = usingRemoteRelay
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
                    Task { @MainActor in
                        self?.fail(error, socket: socket, generation: generation, remote: remote)
                    }
                }
            }
            return true
        } catch {
            fail(error, socket: socket, generation: generation, remote: remote)
            return false
        }
    }

    /// Material bytes deliberately bypass the WebSocket. The socket only carries
    /// small encrypted control messages; uploads use HTTPS so back-pressure,
    /// retries and Cloudflare limits cannot stall approvals or live task updates.
    func uploadMaterial(_ prepared: PreparedMobileMaterial) async throws -> String {
        guard let credentials else { throw MaterialError.message("请先连接 Mac") }
        let remote = usingRemoteRelay
        let baseURL: URL
        if remote {
            guard let relay = credentials.remoteRelayURL, credentials.remoteAccessToken != nil else {
                throw MaterialError.message("远程物料中转尚不可用，请连接 Mac 后重试")
            }
            baseURL = relay
        } else {
            baseURL = credentials.bridgeURL
        }
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        components?.path = remote
            ? "/v1/materials/\(prepared.id)"
            : "/api/materials/\(prepared.id)/blob"
        guard let url = components?.url else { throw MaterialError.message("物料上传地址无效") }
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        if remote {
            request.setValue("Bearer \(credentials.remoteAccessToken ?? "")", forHTTPHeaderField: "Authorization")
        } else {
            let timestamp = ISO8601DateFormatter().string(from: Date())
            guard let deviceKey = ZimloCrypto.fromBase64URL(credentials.deviceKey) else {
                throw MaterialError.message("设备密钥无效，请重新配对")
            }
            request.setValue(credentials.deviceId, forHTTPHeaderField: "X-Zimlo-Device-Id")
            request.setValue(timestamp, forHTTPHeaderField: "X-Zimlo-Timestamp")
            request.setValue(
                ZimloCrypto.proof(key: deviceKey, message: "material-upload:\(prepared.id):\(timestamp):\(prepared.encryptedData.count)"),
                forHTTPHeaderField: "X-Zimlo-Proof"
            )
        }
        let (data, response) = try await URLSession.shared.upload(for: request, from: prepared.encryptedData)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode
            if status == 413 { throw MaterialError.message("文件超过上传限制") }
            if remote, status == 404 {
                throw MaterialError.message("云端物料服务尚未启用，请连接 Mac 本地重试")
            }
            if status == 401 || status == 403 {
                throw MaterialError.message("物料上传认证已失效，请重新连接 Mac")
            }
            if let payload = try? JSONDecoder().decode(MaterialUploadErrorPayload.self, from: data),
               !payload.message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                throw MaterialError.message(payload.message)
            }
            throw MaterialError.message(status.map { "物料上传失败（HTTP \($0)），请重试" } ?? "物料上传失败，请重试")
        }
        return remote ? "cloud" : "local"
    }

    func downloadMaterial(_ material: Material) async throws -> URL {
        if let cached = MaterialCache.url(for: material) { return cached }
        guard let credentials,
              let deviceKey = ZimloCrypto.fromBase64URL(credentials.deviceKey) else {
            throw MaterialError.message("连接到 Mac 后即可查看这个物料")
        }
        if usingRemoteRelay {
            return try await downloadRemoteMaterial(material, credentials: credentials, deviceKey: deviceKey)
        }
        var components = URLComponents(url: credentials.bridgeURL, resolvingAgainstBaseURL: false)
        components?.path = "/api/materials/\(material.id)/content"
        guard let url = components?.url else { throw MaterialError.message("物料地址无效") }
        let timestamp = ISO8601DateFormatter().string(from: Date())
        var request = URLRequest(url: url)
        request.setValue(credentials.deviceId, forHTTPHeaderField: "X-Zimlo-Device-Id")
        request.setValue(timestamp, forHTTPHeaderField: "X-Zimlo-Timestamp")
        request.setValue(
            ZimloCrypto.proof(key: deviceKey, message: "material-download:\(material.id):\(timestamp)"),
            forHTTPHeaderField: "X-Zimlo-Proof"
        )
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw MaterialError.message("物料尚未同步到这台手机")
        }
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard digest == material.sha256 else { throw MaterialError.message("物料完整性校验失败") }
        return try MaterialCache.save(data: data, id: material.id, name: material.name)
    }

    private func downloadRemoteMaterial(
        _ material: Material,
        credentials: DeviceCredentials,
        deviceKey: Data
    ) async throws -> URL {
        guard let relayURL = credentials.remoteRelayURL,
              let accessToken = credentials.remoteAccessToken,
              send(ClientCommand(type: "material.remote.request", ["materialId": .string(material.id)])) else {
            throw MaterialError.message("请先重新连接 Mac，再打开这个物料")
        }
        var components = URLComponents(url: relayURL, resolvingAgainstBaseURL: false)
        components?.path = "/v1/materials/\(material.id)"
        components?.query = nil
        components?.fragment = nil
        guard let url = components?.url else { throw MaterialError.message("云端物料地址无效") }

        let deadline = Date().addingTimeInterval(25)
        while Date() < deadline {
            try Task.checkCancellation()
            var request = URLRequest(url: url)
            request.timeoutInterval = 8
            request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
            let (encrypted, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw MaterialError.message("云端物料服务没有响应")
            }
            if http.statusCode == 404 {
                try await Task.sleep(for: .milliseconds(450))
                continue
            }
            guard http.statusCode == 200 else {
                if http.statusCode == 401 || http.statusCode == 403 {
                    throw MaterialError.message("连接凭据已失效，请在设置中重新连接 Mac")
                }
                throw MaterialError.message("物料下载失败（HTTP \(http.statusCode)）")
            }

            let keyCode = HMAC<SHA256>.authenticationCode(
                for: Data("material-download:\(material.id)".utf8),
                using: SymmetricKey(data: deviceKey)
            )
            let sealedBox = try AES.GCM.SealedBox(combined: encrypted)
            let plaintext = try AES.GCM.open(sealedBox, using: SymmetricKey(data: Data(keyCode)))
            let digest = SHA256.hash(data: plaintext).map { String(format: "%02x", $0) }.joined()
            guard digest == material.sha256 else { throw MaterialError.message("物料完整性校验失败") }
            let localURL = try MaterialCache.save(data: plaintext, id: material.id, name: material.name)

            var deleteRequest = URLRequest(url: url)
            deleteRequest.httpMethod = "DELETE"
            deleteRequest.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
            Task { _ = try? await URLSession.shared.data(for: deleteRequest) }
            return localURL
        }
        throw MaterialError.message("Mac 暂时没有回传这个物料，请确认 Zimlo 正在运行后重试")
    }

    private func connect(remote: Bool, expectedGeneration: UInt64? = nil) {
        if let expectedGeneration, !accepts(generation: expectedGeneration) { return }
        guard !intentionallyStopped, let credentials else { return }
        let generation = beginConnectionGeneration()
        clientTX = nil
        serverTX = nil
        sendCounter = 0
        receiveCounter = 0
        let baseURL = remote ? credentials.remoteRelayURL : credentials.bridgeURL
        guard let baseURL else {
            scheduleReconnect(generation: generation)
            return
        }
        usingRemoteRelay = remote
        retryRemoteNext = !remote
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        components?.scheme = baseURL.scheme == "https" ? "wss" : "ws"
        components?.path = remote ? "/v1/sync/device" : "/ws"
        components?.query = nil
        components?.fragment = nil
        guard let url = components?.url else {
            error = "Bridge 地址无效"
            return
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = remote ? 12 : 3
        if remote, let token = credentials.remoteAccessToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let socket = URLSession.shared.webSocketTask(with: request)
        self.socket = socket
        socket.resume()
        connectionTask = Task { [weak self] in
            await self?.authenticate(
                socket: socket,
                credentials: credentials,
                remote: remote,
                generation: generation
            )
        }
    }

    private func authenticate(
        socket: URLSessionWebSocketTask,
        credentials: DeviceCredentials,
        remote: Bool,
        generation: UInt64
    ) async {
        guard isCurrent(socket: socket, generation: generation),
              let deviceKey = ZimloCrypto.fromBase64URL(credentials.deviceKey) else {
            if isCurrent(socket: socket, generation: generation) {
                fail(ZimloCryptoError.invalidKey, socket: socket, generation: generation, remote: remote)
            }
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
            guard isCurrent(socket: socket, generation: generation) else { return }
            let message = try await socket.receive()
            guard isCurrent(socket: socket, generation: generation) else { return }
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
            guard isCurrent(socket: socket, generation: generation) else { return }
            clientTX = keys.client
            serverTX = keys.server
            connected = true
            connectionMode = remote ? "cloud" : "local"
            error = nil
            reconnectAttempt = 0
            onSecureConnection?()
            guard isCurrent(socket: socket, generation: generation) else { return }
            await receiveLoop(socket: socket, credentials: credentials, remote: remote, generation: generation)
        } catch {
            guard isCurrent(socket: socket, generation: generation) else { return }
            fail(error, socket: socket, generation: generation, remote: remote)
        }
    }

    private func receiveLoop(
        socket: URLSessionWebSocketTask,
        credentials: DeviceCredentials,
        remote: Bool,
        generation: UInt64
    ) async {
        guard isCurrent(socket: socket, generation: generation) else { return }
        do {
            while !Task.isCancelled {
                let message = try await socket.receive()
                guard isCurrent(socket: socket, generation: generation) else { return }
                let frame = try JSONDecoder().decode(SecureFrame.self, from: data(from: message))
                guard frame.type == "secure", frame.counter == receiveCounter,
                      let serverTX else { throw ZimloCryptoError.invalidCounter }
                let plaintext = try ZimloCrypto.decrypt(
                    key: serverTX,
                    counter: frame.counter,
                    ciphertext: frame.ciphertext,
                    aad: "zimlo-ws-v1:\(credentials.deviceId)"
                )
                guard isCurrent(socket: socket, generation: generation) else { return }
                receiveCounter += 1
                let envelope = try JSONDecoder().decode(ServerEnvelope.self, from: plaintext)
                guard isCurrent(socket: socket, generation: generation) else { return }
                onMessage?(envelope)
            }
        } catch {
            guard isCurrent(socket: socket, generation: generation) else { return }
            fail(error, socket: socket, generation: generation, remote: remote)
        }
    }

    private func fail(
        _ failure: Error,
        socket failedSocket: URLSessionWebSocketTask,
        generation: UInt64,
        remote: Bool
    ) {
        guard isCurrent(socket: failedSocket, generation: generation) else { return }
        connected = false
        connectionMode = "offline"
        error = remote ? "Mac 当前离线；已显示手机缓存，操作会在重连后发送" : failure.localizedDescription
        if failedSocket.closeCode == .policyViolation {
            connectionGeneration &+= 1
            connectionTask?.cancel()
            connectionTask = nil
            failedSocket.cancel()
            socket = nil
            KeychainStore.clear()
            credentials = nil
            pairingRequired = true
            intentionallyStopped = true
            error = "设备身份已失效或被撤销，请重新配对"
            return
        }
        failedSocket.cancel()
        socket = nil
        connectionTask = nil
        guard !intentionallyStopped, credentials != nil else { return }
        if retryRemoteNext, credentials?.remoteRelayURL != nil, credentials?.remoteAccessToken != nil {
            reconnectTask?.cancel()
            reconnectTask = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(250))
                guard !Task.isCancelled else { return }
                guard let self, self.accepts(generation: generation) else { return }
                self.connect(remote: true, expectedGeneration: generation)
            }
            return
        }
        scheduleReconnect(generation: generation)
    }

    private func scheduleReconnect(generation: UInt64? = nil) {
        reconnectTask?.cancel()
        // 系统离线时暂停；网络恢复由 NWPathMonitor 立即触发重连。
        guard networkAvailable, !intentionallyStopped else { return }
        let expectedGeneration = generation ?? connectionGeneration
        guard accepts(generation: expectedGeneration) else { return }
        let delayMs = ReconnectBackoff.delayMs(attempt: Double(reconnectAttempt), random: backoffRandom)
        reconnectAttempt += 1
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(delayMs))
            guard !Task.isCancelled else { return }
            guard let self, self.accepts(generation: expectedGeneration) else { return }
            let canUseRemote = self.credentials?.remoteRelayURL != nil
                && self.credentials?.remoteAccessToken != nil
            self.connect(remote: canUseRemote && self.retryRemoteNext, expectedGeneration: expectedGeneration)
        }
    }

    /// Every async connection path carries a generation lease. Replacing,
    /// stopping, forgetting, or re-pairing advances the lease so late awaits
    /// can neither mutate the new connection nor deliver stale snapshots.
    @discardableResult
    private func beginConnectionGeneration(
        closeCode: URLSessionWebSocketTask.CloseCode = .goingAway
    ) -> UInt64 {
        connectionGeneration &+= 1
        connectionTask?.cancel()
        connectionTask = nil
        socket?.cancel(with: closeCode, reason: nil)
        socket = nil
        connected = false
        connectionMode = "offline"
        clientTX = nil
        serverTX = nil
        sendCounter = 0
        receiveCounter = 0
        return connectionGeneration
    }

    private func invalidateConnection(closeCode: URLSessionWebSocketTask.CloseCode) {
        _ = beginConnectionGeneration(closeCode: closeCode)
    }

    private func accepts(generation: UInt64) -> Bool {
        BridgeConnectionLeaseRules.accepts(
            expectedGeneration: generation,
            currentGeneration: connectionGeneration,
            intentionallyStopped: intentionallyStopped
        )
    }

    private func isCurrent(socket candidate: URLSessionWebSocketTask, generation: UInt64) -> Bool {
        accepts(generation: generation) && socket === candidate
    }

    private func finishStartup(generation: UInt64) {
        guard startupGeneration == generation else { return }
        startupGeneration = nil
        startupTask = nil
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
            pairingToken: values["pairingToken"],
            clientPublicKey: ZimloCrypto.base64URL(pair.publicKey.rawRepresentation),
            proof: ZimloCrypto.proof(key: pairKey, message: "client:\(pairingId)"),
            name: UIDevice.current.name
        )
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(body)
        var (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw PairingError.expired
        }
        if http.statusCode == 202 {
            guard let pairingToken = values["pairingToken"] else { throw PairingError.invalidResponse }
            let pending = try JSONDecoder().decode(PairingPending.self, from: data)
            (data, response) = try await pollPairing(
                components: components,
                pairingId: pairingId,
                pairingToken: pairingToken,
                requestId: pending.requestId
            )
        }
        guard let completed = response as? HTTPURLResponse, completed.statusCode == 200 else {
            throw PairingError.expired
        }
        let result = try JSONDecoder().decode(PairResponse.self, from: data)
        guard ZimloCrypto.verifyProof(key: pairKey, message: "server:\(result.deviceId)", proof: result.serverProof) else {
            throw ZimloCryptoError.invalidProof
        }
        return DeviceCredentials(
            bridgeURL: bridgeURL,
            deviceId: result.deviceId,
            deviceKey: ZimloCrypto.base64URL(ZimloCrypto.deviceKey(pairKey: pairKey, secret: secret)),
            remoteRelayURL: result.cloud?.relayURL,
            remoteAccessToken: result.cloud?.accessToken
        )
    }

    private func pollPairing(
        components: URLComponents,
        pairingId: String,
        pairingToken: String,
        requestId: String
    ) async throws -> (Data, URLResponse) {
        for _ in 0..<120 {
            try await Task.sleep(for: .milliseconds(500))
            var resultEndpoint = components
            resultEndpoint.path = "/api/pair"
            resultEndpoint.queryItems = [
                URLQueryItem(name: "pairingId", value: pairingId),
                URLQueryItem(name: "pairingToken", value: pairingToken),
                URLQueryItem(name: "requestId", value: requestId),
            ]
            guard let url = resultEndpoint.url else { throw PairingError.invalidLink }
            var request = URLRequest(url: url)
            request.timeoutInterval = 5
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { continue }
            if http.statusCode == 200 { return (data, response) }
            if http.statusCode != 202 { throw PairingError.expired }
        }
        throw PairingError.expired
    }

    private func prefersRemote(_ credentials: DeviceCredentials) -> Bool {
        guard credentials.remoteAccessToken != nil,
              let remote = credentials.remoteRelayURL else { return false }
        return remote.host == credentials.bridgeURL.host
    }

    private func verifyProtocol(at bridgeURL: URL) async throws {
        var components = URLComponents(url: bridgeURL, resolvingAgainstBaseURL: false)
        components?.path = "/healthz"
        guard let url = components?.url else { throw PairingError.invalidLink }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2.5
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200,
              let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              value["protocolVersion"] as? Int == 3 else {
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

private struct MaterialUploadErrorPayload: Decodable {
    let message: String
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
    var pairingToken: String?
    var clientPublicKey: String
    var proof: String
    var name: String
}

private struct PairingPending: Codable {
    var requestId: String
}

private struct PairResponse: Codable {
    var deviceId: String
    var serverProof: String
    var cloud: PairCloud?
}

private struct PairCloud: Codable {
    var relayURL: URL
    var accessToken: String
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
