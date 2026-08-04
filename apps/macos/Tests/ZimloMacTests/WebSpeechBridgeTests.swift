import Foundation
import XCTest
@testable import ZimloMac

final class WebSpeechBridgeTests: XCTestCase {
    func testEventScriptDecodesNativePayloadAsUTF8() throws {
        let script = try XCTUnwrap(WebSpeechEventScript.make(
            payload: [
                "type": "error",
                "message": "请在系统设置中允许 Zimlo 使用麦克风",
            ],
            eventName: "zimlo:native-speech"
        ))

        XCTAssertTrue(script.contains("new TextDecoder('utf-8').decode(bytes)"))
        XCTAssertTrue(script.contains("Uint8Array.from(binary"))
        XCTAssertFalse(script.contains("JSON.parse(atob("))
        XCTAssertTrue(script.contains("zimlo:native-speech"))
    }

    func testEventScriptRejectsInvalidJSONPayload() {
        XCTAssertNil(WebSpeechEventScript.make(
            payload: ["invalid": Date()],
            eventName: "zimlo:native-speech"
        ))
    }
}
