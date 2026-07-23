import XCTest
@testable import Zimlo

final class CryptoTests: XCTestCase {
    func testBase64URLRoundTrip() {
        let data = Data((0..<255).map(UInt8.init))
        XCTAssertEqual(ZimloCrypto.fromBase64URL(ZimloCrypto.base64URL(data)), data)
    }

    func testXChaChaMatchesTypeScriptProtocolVector() throws {
        let key = Data((0..<32).map(UInt8.init))
        let encrypted = "IpCSDXE_ko8r_eq7oP-MIGA06458nVAqf295Cts3DW5lhKXxgoeH4sehHph6mZse68DtaU6PrVcU37a2CQ"
        let plaintext = try ZimloCrypto.decrypt(
            key: key,
            counter: 42,
            ciphertext: encrypted,
            aad: "zimlo-ws-v1:test-device"
        )
        XCTAssertEqual(String(decoding: plaintext, as: UTF8.self), #"{"type":"snapshot.request","afterSequence":7}"#)
    }

    func testXChaChaRejectsTampering() throws {
        let key = Data((0..<32).map(UInt8.init))
        let ciphertext = try ZimloCrypto.encrypt(
            key: key,
            counter: 2,
            value: Data("hello".utf8),
            aad: "zimlo-ws-v1:test"
        )
        var bytes = try XCTUnwrap(ZimloCrypto.fromBase64URL(ciphertext))
        bytes[0] ^= 1
        XCTAssertThrowsError(
            try ZimloCrypto.decrypt(
                key: key,
                counter: 2,
                ciphertext: ZimloCrypto.base64URL(bytes),
                aad: "zimlo-ws-v1:test"
            )
        )
    }
}
