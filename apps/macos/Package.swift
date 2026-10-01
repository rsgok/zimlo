// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ZimloMac",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Zimlo", targets: ["ZimloMac"]),
    ],
    dependencies: [
        .package(path: "../../packages/swift/ZimloCore"),
        .package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.9.2"),
    ],
    targets: [
        .executableTarget(
            name: "ZimloMac",
            dependencies: [
                .product(name: "Sparkle", package: "Sparkle"),
                .product(name: "ZimloCore", package: "ZimloCore"),
            ],
            path: "Sources/ZimloMac"
        ),
        .testTarget(
            name: "ZimloMacTests",
            dependencies: ["ZimloMac"],
            path: "Tests/ZimloMacTests"
        ),
    ]
)
