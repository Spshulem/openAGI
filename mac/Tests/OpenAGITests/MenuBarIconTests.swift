import AppKit
import XCTest
@testable import OpenAGI

/// The menu bar icon is vector, a template, sized to fit the menu bar
/// unscaled, and sharp at native resolution. With OPENAGI_UI_SNAPSHOT_DIR
/// set (CI), it also writes evidence: offscreen renders at 1x/2x/3x on light
/// and dark backgrounds, and a real NSStatusItem capture from the runner's
/// menu bar.
@MainActor
final class MenuBarIconTests: XCTestCase {
  private var outputDirectory: URL? {
    guard let dir = ProcessInfo.processInfo.environment["OPENAGI_UI_SNAPSHOT_DIR"], !dir.isEmpty else { return nil }
    let url = URL(fileURLWithPath: dir, isDirectory: true).appendingPathComponent("menu-bar-icon", isDirectory: true)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }

  func testIconIsAVectorTemplateThatFitsTheMenuBar() {
    let image = MenuBarIcon.makeImage()
    XCTAssertTrue(image.isTemplate, "macOS tints a template for light/dark and highlight")
    XCTAssertEqual(image.size, MenuBarIcon.canvasSize)
    XCTAssertFalse(image.representations.contains { $0 is NSBitmapImageRep }, "no bitmap to upscale")
    XCTAssertTrue(image.representations.contains { $0 is NSCustomImageRep }, "drawn at the backing scale")
    XCTAssertLessThanOrEqual(image.size.height, NSStatusBar.system.thickness, "never scaled down by the menu bar")
  }

  func testGlyphSitsOnWholePointsAndKeepsItsProportions() {
    let rect = MenuBarIcon.glyphRect(in: NSRect(origin: .zero, size: MenuBarIcon.canvasSize), glyphHeight: MenuBarIcon.glyphHeight)
    XCTAssertEqual(rect.minX, rect.minX.rounded())
    XCTAssertEqual(rect.minY, rect.minY.rounded())
    XCTAssertEqual(rect.height, MenuBarIcon.glyphHeight)
    XCTAssertEqual(rect.width / rect.height, MenuBarIcon.glyphBounds.width / MenuBarIcon.glyphBounds.height, accuracy: 0.001)
  }

  func testNativeRenderIsSharpAtEveryScale() throws {
    for scale in [1, 2, 3] {
      let alpha = Self.alpha(of: MenuBarIcon.makeImage(), scale: CGFloat(scale))
      let box = try XCTUnwrap(alpha.boundingBox(threshold: 128))
      // The glyph is the height it should be, in device pixels.
      XCTAssertEqual(CGFloat(box.height), MenuBarIcon.glyphHeight * CGFloat(scale), accuracy: 1.5, "at \(scale)x")
      // Solid ink, not a smear. The vector glyph measured 0.13 / 0.40 / 0.57
      // at 1x / 2x / 3x on CI; the previous bitmap shown at 26 pt measured
      // 0.008 / 0.014 / 0.025, the fuzz the owner saw.
      let floor: [Int: Double] = [1: 0.08, 2: 0.3, 3: 0.45]
      XCTAssertGreaterThan(alpha.solidShare, floor[scale]!, "at \(scale)x")
    }
  }

  func testWriteEvidence() throws {
    guard let dir = outputDirectory else { throw XCTSkip("Set OPENAGI_UI_SNAPSHOT_DIR to write menu bar icon evidence.") }
    _ = NSApplication.shared
    var report: [String: Any] = [
      "screenBackingScale": NSScreen.main?.backingScaleFactor ?? 0,
      "statusBarThickness": NSStatusBar.system.thickness,
      "canvasPoints": [MenuBarIcon.canvasSize.width, MenuBarIcon.canvasSize.height],
      "glyphHeightPoints": MenuBarIcon.glyphHeight,
    ]
    let images: [(String, NSImage)] = [("after", MenuBarIcon.makeImage())]

    for (name, image) in images {
      for scale in [1, 2, 3] {
        let alpha = Self.alpha(of: image, scale: CGFloat(scale))
        report["\(name)-\(scale)x-solidShare"] = alpha.solidShare
        report["\(name)-\(scale)x-glyphPixelHeight"] = alpha.boundingBox(threshold: 128)?.height ?? 0
        for (appearance, ink, background) in [("light", NSColor.black, NSColor(white: 0.93, alpha: 1)),
                                              ("dark", NSColor.white, NSColor(white: 0.16, alpha: 1))] {
          let png = Self.tintedPNG(image, scale: CGFloat(scale), ink: ink, background: background, magnify: CGFloat(12 / scale))
          try png.write(to: dir.appendingPathComponent("\(name)-\(scale)x-\(appearance).png"))
        }
      }
      // The real menu bar on this runner: a status item with this image.
      for appearance in [NSAppearance.Name.aqua, .darkAqua] {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = image
        item.button?.appearance = NSAppearance(named: appearance)
        RunLoop.main.run(until: Date().addingTimeInterval(1.0))
        if let window = item.button?.window {
          let file = dir.appendingPathComponent("\(name)-statusitem-\(appearance == .aqua ? "light" : "dark").png")
          // The status item's own window; if the system declines that, the
          // same rectangle of the screen (screencapture -R is top-left).
          Self.screencapture(["-x", "-o", "-l\(window.windowNumber)", file.path])
          if !FileManager.default.fileExists(atPath: file.path), let screen = window.screen ?? NSScreen.main {
            let f = window.frame
            let top = screen.frame.maxY - f.maxY
            Self.screencapture(["-x", "-R\(Int(f.minX)),\(Int(top)),\(Int(f.width)),\(Int(f.height))", file.path])
          }
          if let shot = NSImage(contentsOf: file), let rep = shot.representations.first as? NSBitmapImageRep {
            report["\(name)-statusitem-\(appearance == .aqua ? "light" : "dark")-pixels"] = [rep.pixelsWide, rep.pixelsHigh]
            report["\(name)-statusitem-\(appearance == .aqua ? "light" : "dark")-glyphPixelHeight"] = Self.inkHeight(rep) ?? 0
          }
          report["\(name)-statusitem-buttonPoints"] = [item.button?.bounds.width ?? 0, item.button?.bounds.height ?? 0]
        }
        NSStatusBar.system.removeStatusItem(item)
      }
    }
    let json = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
    try json.write(to: dir.appendingPathComponent("measurements.json"))
  }

  // MARK: - Rendering helpers

  private static func screencapture(_ arguments: [String]) {
    let capture = Process()
    capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    capture.arguments = arguments
    try? capture.run()
    capture.waitUntilExit()
  }

  struct Alpha {
    let width: Int
    let height: Int
    let values: [UInt8]

    func boundingBox(threshold: UInt8) -> (width: Int, height: Int)? {
      var minX = width, minY = height, maxX = -1, maxY = -1
      for y in 0..<height {
        for x in 0..<width where values[y * width + x] >= threshold {
          minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
        }
      }
      return maxX < 0 ? nil : (maxX - minX + 1, maxY - minY + 1)
    }

    /// Of the pixels the glyph touches, the share that is solid ink. Blur
    /// (an upscaled bitmap) spreads the edge over many half-transparent
    /// pixels and lowers it.
    var solidShare: Double {
      let touched = values.filter { $0 > 12 }.count
      guard touched > 0 else { return 0 }
      return Double(values.filter { $0 >= 243 }.count) / Double(touched)
    }
  }

  /// The image drawn into a bitmap at `scale` device pixels per point.
  static func alpha(of image: NSImage, scale: CGFloat) -> Alpha {
    let rep = bitmap(for: image.size, scale: scale)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    image.draw(in: NSRect(origin: .zero, size: image.size))
    NSGraphicsContext.restoreGraphicsState()
    var values: [UInt8] = []
    values.reserveCapacity(rep.pixelsWide * rep.pixelsHigh)
    for y in 0..<rep.pixelsHigh {
      for x in 0..<rep.pixelsWide {
        values.append(UInt8(((rep.colorAt(x: x, y: y)?.alphaComponent ?? 0) * 255).rounded()))
      }
    }
    return Alpha(width: rep.pixelsWide, height: rep.pixelsHigh, values: values)
  }

  /// The template tinted as the menu bar would, on a flat background,
  /// magnified with nearest-neighbor so each device pixel stays visible.
  static func tintedPNG(_ image: NSImage, scale: CGFloat, ink: NSColor, background: NSColor, magnify: CGFloat) -> Data {
    let tinted = NSImage(size: image.size, flipped: false) { rect in
      image.draw(in: rect)
      ink.set()
      rect.fill(using: .sourceAtop)
      return true
    }
    let native = bitmap(for: image.size, scale: scale)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: native)
    background.setFill()
    NSRect(origin: .zero, size: image.size).fill()
    tinted.draw(in: NSRect(origin: .zero, size: image.size))
    NSGraphicsContext.restoreGraphicsState()

    let factor = max(1, Int(magnify.rounded()))
    let big = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: native.pixelsWide * factor, pixelsHigh: native.pixelsHigh * factor,
                               bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                               colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    let context = NSGraphicsContext(bitmapImageRep: big)!
    context.imageInterpolation = .none
    NSGraphicsContext.current = context
    native.draw(in: NSRect(x: 0, y: 0, width: big.pixelsWide, height: big.pixelsHigh))
    NSGraphicsContext.restoreGraphicsState()
    return big.representation(using: .png, properties: [:]) ?? Data()
  }

  private static func bitmap(for size: NSSize, scale: CGFloat) -> NSBitmapImageRep {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil,
                               pixelsWide: Int((size.width * scale).rounded()), pixelsHigh: Int((size.height * scale).rounded()),
                               bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                               colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = size
    return rep
  }

  /// Height in pixels of whatever differs clearly from the capture's
  /// corner color: the glyph in a status item screenshot.
  private static func inkHeight(_ rep: NSBitmapImageRep) -> Int? {
    guard let corner = rep.colorAt(x: 0, y: 0)?.usingColorSpace(.deviceRGB) else { return nil }
    var minY = Int.max, maxY = -1
    for y in 0..<rep.pixelsHigh {
      for x in 0..<rep.pixelsWide {
        guard let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) else { continue }
        let d = abs(c.redComponent - corner.redComponent) + abs(c.greenComponent - corner.greenComponent) + abs(c.blueComponent - corner.blueComponent)
        if d > 0.6 { minY = min(minY, y); maxY = max(maxY, y) }
      }
    }
    return maxY < 0 ? nil : maxY - minY + 1
  }
}
