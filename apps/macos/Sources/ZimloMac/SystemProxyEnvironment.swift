import CFNetwork
import Foundation

/// Converts the active macOS HTTP proxy into the environment understood by
/// Node's `--use-env-proxy`. Local Bridge traffic must always bypass it.
enum SystemProxyEnvironment {
    static func current() -> [String: String] {
        guard let raw = CFNetworkCopySystemProxySettings()?.takeRetainedValue(),
              let settings = raw as? [String: Any] else { return [:] }
        return environment(from: settings)
    }

    static func environment(from settings: [String: Any]) -> [String: String] {
        var result: [String: String] = [:]
        if let proxy = proxyURL(
            settings: settings,
            enabledKey: "HTTPEnable",
            hostKey: "HTTPProxy",
            portKey: "HTTPPort"
        ) {
            result["HTTP_PROXY"] = proxy
        }
        if let proxy = proxyURL(
            settings: settings,
            enabledKey: "HTTPSEnable",
            hostKey: "HTTPSProxy",
            portKey: "HTTPSPort"
        ) {
            result["HTTPS_PROXY"] = proxy
        }

        var exclusions = (settings["ExceptionsList"] as? [String] ?? [])
            .filter { !$0.isEmpty && $0 != "<local>" }
        exclusions.append(contentsOf: ["127.0.0.1", "localhost", "::1"])
        var seen = Set<String>()
        let unique = exclusions.filter { seen.insert($0).inserted }
        if !unique.isEmpty {
            result["NO_PROXY"] = unique.joined(separator: ",")
        }
        return result
    }

    private static func proxyURL(
        settings: [String: Any],
        enabledKey: String,
        hostKey: String,
        portKey: String
    ) -> String? {
        guard (settings[enabledKey] as? NSNumber)?.boolValue == true,
              let rawHost = settings[hostKey] as? String else { return nil }
        let host = rawHost.trimmingCharacters(in: .whitespacesAndNewlines)
        let port = (settings[portKey] as? NSNumber)?.intValue ?? 0
        guard !host.isEmpty, (1...65_535).contains(port) else { return nil }
        let formattedHost = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
        // macOS HTTP/HTTPS proxy settings both describe an HTTP CONNECT proxy.
        return "http://\(formattedHost):\(port)"
    }
}
