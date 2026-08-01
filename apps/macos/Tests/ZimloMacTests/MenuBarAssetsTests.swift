import AppKit
import XCTest
@testable import ZimloMac

@MainActor
final class MenuBarAssetsTests: XCTestCase {
    func testEveryServiceStateProducesAVisibleTemplateIcon() throws {
        let states: [ServiceState] = [
            .ready,
            .starting,
            .stopping,
            .manualStopped,
            .degraded("offline"),
            .unavailable("failed"),
        ]

        for state in states {
            let image = MenuBarAssets.icon(for: state)
            XCTAssertTrue(image.isTemplate)
            XCTAssertEqual(image.size, MenuBarAssets.size)

            let tiff = try XCTUnwrap(image.tiffRepresentation)
            let bitmap = try XCTUnwrap(NSBitmapImageRep(data: tiff))
            let visiblePixels = (0..<bitmap.pixelsHigh).reduce(into: 0) { count, y in
                for x in 0..<bitmap.pixelsWide where (bitmap.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0.05 {
                    count += 1
                }
            }
            XCTAssertGreaterThan(visiblePixels, 24, "Missing menu-bar drawing for \(state)")
        }
    }
}
