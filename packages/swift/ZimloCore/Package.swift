// swift-tools-version: 6.0
import PackageDescription

let package = Package(name: "ZimloCore", platforms: [.macOS(.v14), .iOS(.v17)],
    products: [.library(name: "ZimloCore", targets: ["ZimloCore"])],
    targets: [.target(name: "ZimloCore"), .testTarget(name: "ZimloCoreTests", dependencies: ["ZimloCore"])])
