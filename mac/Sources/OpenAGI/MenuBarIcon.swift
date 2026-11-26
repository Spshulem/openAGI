import AppKit

/// The OpenAGI menu bar icon.
///
/// The glyph is vector paths (MenuBarIconGlyph.swift, traced from
/// mac/Resources/icon-sources/MenuIcon-source.png), drawn by the image's
/// drawing handler at whatever backing scale the menu bar renders: sharp at
/// 1x, 2x and any scale. It replaced a single 28 px PNG that was shown at
/// 26 pt, so on Retina displays it was upscaled about 1.9x and looked fuzzy.
///
/// It is a template image: macOS tints it for light and dark menu bars and
/// for the highlighted state, as before.
enum MenuBarIcon {
  /// The glyph's height in points: the size the previous bitmap's glyph
  /// appeared at (14 px of a 28 px image shown at 26 pt).
  static let glyphHeight: CGFloat = 14
  /// The image's size in points, fits the menu bar without being scaled.
  static let canvasSize = NSSize(width: 18, height: 18)

  enum PathElement {
    case move(CGFloat, CGFloat)
    case line(CGFloat, CGFloat)
    /// To (x, y), with control points (c1x, c1y) and (c2x, c2y).
    case curve(CGFloat, CGFloat, CGFloat, CGFloat, CGFloat, CGFloat)
    case close
  }

  static func makeImage(canvasSize: NSSize = canvasSize, glyphHeight: CGFloat = glyphHeight) -> NSImage {
    let image = NSImage(size: canvasSize, flipped: true) { rect in
      NSColor.black.setFill()
      path(in: glyphRect(in: rect, glyphHeight: glyphHeight)).fill()
      return true
    }
    image.isTemplate = true
    image.accessibilityDescription = "OpenAGI"
    return image
  }

  /// Where the glyph sits in a canvas: centered, starting on whole points so
  /// its edges line up with the pixel grid the same way at every scale.
  static func glyphRect(in canvas: NSRect, glyphHeight: CGFloat) -> NSRect {
    let height = min(glyphHeight, canvas.height)
    let width = height * glyphBounds.width / glyphBounds.height
    return NSRect(
      x: canvas.minX + ((canvas.width - width) / 2).rounded(),
      y: canvas.minY + ((canvas.height - height) / 2).rounded(),
      width: width,
      height: height
    )
  }

  /// The glyph scaled into `rect` (y down, as in a flipped image).
  static func path(in rect: NSRect) -> NSBezierPath {
    let sx = rect.width / glyphBounds.width
    let sy = rect.height / glyphBounds.height
    func point(_ x: CGFloat, _ y: CGFloat) -> NSPoint {
      NSPoint(x: rect.minX + (x - glyphBounds.minX) * sx, y: rect.minY + (y - glyphBounds.minY) * sy)
    }
    let path = NSBezierPath()
    path.windingRule = .evenOdd
    for element in glyphPath {
      switch element {
      case let .move(x, y):
        path.move(to: point(x, y))
      case let .line(x, y):
        path.line(to: point(x, y))
      case let .curve(x, y, c1x, c1y, c2x, c2y):
        path.curve(to: point(x, y), controlPoint1: point(c1x, c1y), controlPoint2: point(c2x, c2y))
      case .close:
        path.close()
      }
    }
    return path
  }
}
