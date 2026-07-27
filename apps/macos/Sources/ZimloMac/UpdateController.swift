import Foundation
import Sparkle

@MainActor
final class UpdateController {
    private let controller: SPUStandardUpdaterController?

    init(bundle: Bundle = .main) {
        let feedURL = bundle.object(forInfoDictionaryKey: "SUFeedURL") as? String
        let publicKey = bundle.object(forInfoDictionaryKey: "SUPublicEDKey") as? String
        let configured = feedURL?.hasPrefix("https://") == true
            && publicKey?.isEmpty == false
            && publicKey != "__SPARKLE_PUBLIC_KEY__"
        controller = configured
            ? SPUStandardUpdaterController(
                startingUpdater: true,
                updaterDelegate: nil,
                userDriverDelegate: nil
            )
            : nil
    }

    var isConfigured: Bool {
        controller != nil
    }

    func checkForUpdates() {
        controller?.checkForUpdates(nil)
    }
}
