// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "OpenAGI",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "OpenAGI", targets: ["OpenAGI"]),
    .executable(name: "OpenAGIComputerHelper", targets: ["OpenAGIComputerHelper"])
  ],
  dependencies: [
    .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.6.0")
  ],
  targets: [
    .executableTarget(
      name: "OpenAGI",
      dependencies: [
        .product(name: "Sparkle", package: "Sparkle"),
        "OpenAGIComputerCore"
      ],
      path: "Sources/OpenAGI"
    ),
    .target(
      name: "OpenAGIComputerCore",
      path: "Sources/OpenAGIComputerCore"
    ),
    .executableTarget(
      name: "OpenAGIComputerHelper",
      dependencies: ["OpenAGIComputerCore"],
      path: "Sources/OpenAGIComputerHelper"
    ),
    .testTarget(
      name: "OpenAGITests",
      dependencies: ["OpenAGI"],
      path: "Tests/OpenAGITests"
    )
  ]
)
