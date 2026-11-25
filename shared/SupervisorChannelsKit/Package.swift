// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SupervisorChannelsKit",
    platforms: [
        .macOS(.v13),
        .iOS(.v17)
    ],
    products: [
        .library(
            name: "SupervisorChannelsKit",
            targets: ["SupervisorChannelsKit"]
        )
    ],
    targets: [
        .target(
            name: "SupervisorChannelsKit",
            path: "Sources/SupervisorChannelsKit"
        ),
        .testTarget(
            name: "SupervisorChannelsKitTests",
            dependencies: ["SupervisorChannelsKit"],
            path: "Tests/SupervisorChannelsKitTests"
        )
    ]
)
