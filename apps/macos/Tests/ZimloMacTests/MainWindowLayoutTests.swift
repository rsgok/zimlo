import XCTest
@testable import ZimloMac

final class MainWindowLayoutTests: XCTestCase {
    func testDesktopContentHasAUsableMinimumSize() {
        XCTAssertGreaterThanOrEqual(MainWindowLayout.minimumContentSize.width, 920)
        XCTAssertGreaterThanOrEqual(MainWindowLayout.minimumContentSize.height, 640)
        XCTAssertGreaterThan(MainWindowLayout.initialContentSize.width, MainWindowLayout.minimumContentSize.width)
        XCTAssertGreaterThan(MainWindowLayout.initialContentSize.height, MainWindowLayout.minimumContentSize.height)
    }
}
