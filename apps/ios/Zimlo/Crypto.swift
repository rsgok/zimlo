import CryptoKit
import Foundation

enum ZimloCryptoError: LocalizedError {
    case invalidKey
    case invalidCiphertext
    case invalidProof
    case invalidCounter

    var errorDescription: String? {
        switch self {
        case .invalidKey: "密钥格式无效"
        case .invalidCiphertext: "Bridge 消息无法解密"
        case .invalidProof: "Bridge 身份校验失败"
        case .invalidCounter: "检测到消息重放或丢帧"
        }
    }
}

enum ZimloCrypto {
    private static let infoPair = Data("zimlo-pair-v1".utf8)
    private static let infoDevice = Data("zimlo-device-v1".utf8)
    private static let infoClientTX = Data("zimlo-ws-client-tx-v1".utf8)
    private static let infoServerTX = Data("zimlo-ws-server-tx-v1".utf8)

    static func randomBytes(count: Int) -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        _ = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        return Data(bytes)
    }

    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func fromBase64URL(_ value: String) -> Data? {
        var normalized = value.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        normalized += String(repeating: "=", count: (4 - normalized.count % 4) % 4)
        return Data(base64Encoded: normalized)
    }

    static func pairKey(
        privateKey: Curve25519.KeyAgreement.PrivateKey,
        peerPublicKey: Data,
        secret: Data
    ) throws -> Data {
        let peer = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: peerPublicKey)
        let shared = try privateKey.sharedSecretFromKeyAgreement(with: peer)
        let key = shared.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: secret,
            sharedInfo: infoPair,
            outputByteCount: 32
        )
        return key.data
    }

    static func deviceKey(pairKey: Data, secret: Data) -> Data {
        HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: pairKey),
            salt: secret,
            info: infoDevice,
            outputByteCount: 32
        ).data
    }

    static func connectionKeys(deviceKey: Data, clientNonce: Data, serverNonce: Data) -> (client: Data, server: Data) {
        let salt = clientNonce + serverNonce
        let material = SymmetricKey(data: deviceKey)
        return (
            HKDF<SHA256>.deriveKey(inputKeyMaterial: material, salt: salt, info: infoClientTX, outputByteCount: 32).data,
            HKDF<SHA256>.deriveKey(inputKeyMaterial: material, salt: salt, info: infoServerTX, outputByteCount: 32).data
        )
    }

    static func proof(key: Data, message: String) -> String {
        let signature = HMAC<SHA256>.authenticationCode(for: Data(message.utf8), using: SymmetricKey(data: key))
        return base64URL(Data(signature))
    }

    static func verifyProof(key: Data, message: String, proof: String) -> Bool {
        guard let supplied = fromBase64URL(proof) else { return false }
        let expected = Data(HMAC<SHA256>.authenticationCode(for: Data(message.utf8), using: SymmetricKey(data: key)))
        return supplied.count == expected.count && supplied.withUnsafeBytes { (suppliedBytes: UnsafeRawBufferPointer) in
            expected.withUnsafeBytes { (expectedBytes: UnsafeRawBufferPointer) in
                var difference: UInt8 = 0
                for index in 0..<supplied.count {
                    difference |= suppliedBytes[index] ^ expectedBytes[index]
                }
                return difference == 0
            }
        }
    }

    static func encrypt(key: Data, counter: UInt64, value: Data, aad: String) throws -> String {
        let nonce = counterNonce(counter)
        let subkey = hChaCha20(key: key, nonce: Data(nonce.prefix(16)))
        let cryptoNonce = try ChaChaPoly.Nonce(data: Data(repeating: 0, count: 4) + nonce.suffix(8))
        let sealed = try ChaChaPoly.seal(
            value,
            using: SymmetricKey(data: subkey),
            nonce: cryptoNonce,
            authenticating: Data(aad.utf8)
        )
        return base64URL(sealed.ciphertext + sealed.tag)
    }

    static func decrypt(key: Data, counter: UInt64, ciphertext: String, aad: String) throws -> Data {
        guard let encrypted = fromBase64URL(ciphertext), encrypted.count >= 16 else {
            throw ZimloCryptoError.invalidCiphertext
        }
        let nonce = counterNonce(counter)
        let subkey = hChaCha20(key: key, nonce: Data(nonce.prefix(16)))
        let cryptoNonce = try ChaChaPoly.Nonce(data: Data(repeating: 0, count: 4) + nonce.suffix(8))
        let split = encrypted.count - 16
        let box = try ChaChaPoly.SealedBox(
            nonce: cryptoNonce,
            ciphertext: encrypted.prefix(split),
            tag: encrypted.suffix(16)
        )
        return try ChaChaPoly.open(box, using: SymmetricKey(data: subkey), authenticating: Data(aad.utf8))
    }

    private static func counterNonce(_ counter: UInt64) -> Data {
        var bytes = [UInt8](repeating: 0, count: 24)
        for index in 0..<8 {
            bytes[16 + index] = UInt8((counter >> UInt64((7 - index) * 8)) & 0xff)
        }
        return Data(bytes)
    }

    private static func hChaCha20(key: Data, nonce: Data) -> Data {
        precondition(key.count == 32 && nonce.count == 16)
        let constants: [UInt32] = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]
        let keyWords = words(key)
        let nonceWords = words(nonce)
        var state = constants + keyWords + nonceWords
        for _ in 0..<10 {
            quarterRound(&state, 0, 4, 8, 12)
            quarterRound(&state, 1, 5, 9, 13)
            quarterRound(&state, 2, 6, 10, 14)
            quarterRound(&state, 3, 7, 11, 15)
            quarterRound(&state, 0, 5, 10, 15)
            quarterRound(&state, 1, 6, 11, 12)
            quarterRound(&state, 2, 7, 8, 13)
            quarterRound(&state, 3, 4, 9, 14)
        }
        let output = [state[0], state[1], state[2], state[3], state[12], state[13], state[14], state[15]]
        return Data(output.flatMap { word in
            [UInt8(word & 0xff), UInt8((word >> 8) & 0xff), UInt8((word >> 16) & 0xff), UInt8((word >> 24) & 0xff)]
        })
    }

    private static func words(_ data: Data) -> [UInt32] {
        let bytes = [UInt8](data)
        var result: [UInt32] = []
        result.reserveCapacity(bytes.count / 4)
        for index in stride(from: 0, to: bytes.count, by: 4) {
            let byte0 = UInt32(bytes[index])
            let byte1 = UInt32(bytes[index + 1]) << 8
            let byte2 = UInt32(bytes[index + 2]) << 16
            let byte3 = UInt32(bytes[index + 3]) << 24
            result.append(byte0 | byte1 | byte2 | byte3)
        }
        return result
    }

    private static func quarterRound(_ state: inout [UInt32], _ a: Int, _ b: Int, _ c: Int, _ d: Int) {
        state[a] &+= state[b]; state[d] ^= state[a]; state[d] = rotateLeft(state[d], 16)
        state[c] &+= state[d]; state[b] ^= state[c]; state[b] = rotateLeft(state[b], 12)
        state[a] &+= state[b]; state[d] ^= state[a]; state[d] = rotateLeft(state[d], 8)
        state[c] &+= state[d]; state[b] ^= state[c]; state[b] = rotateLeft(state[b], 7)
    }

    private static func rotateLeft(_ value: UInt32, _ count: UInt32) -> UInt32 {
        (value << count) | (value >> (32 - count))
    }
}

private extension SymmetricKey {
    var data: Data { withUnsafeBytes { Data($0) } }
}
