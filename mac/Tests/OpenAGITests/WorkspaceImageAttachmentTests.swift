import AppKit
import XCTest
@testable import OpenAGI

@MainActor
final class WorkspaceImageAttachmentTests: XCTestCase {
  private func makeTestPNG(at url: URL) throws {
    let image = NSImage(size: NSSize(width: 24, height: 24))
    image.lockFocus()
    NSColor.systemBlue.setFill()
    NSRect(x: 0, y: 0, width: 24, height: 24).fill()
    image.unlockFocus()
    guard let tiff = image.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff),
          let png = rep.representation(using: .png, properties: [:]) else {
      throw NSError(domain: "Test", code: 1)
    }
    try png.write(to: url)
  }

  func testExtractInlineCleanShotPathWithSpacesAndProse() throws {
    let tempDir = FileManager.default.temporaryDirectory
      .appendingPathComponent("CleanShot Test \(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: tempDir) }

    let shotURL = tempDir.appendingPathComponent("CleanShot 2026-11-18 at 15.10.04@2x.png")
    try makeTestPNG(at: shotURL)

    let raw = "\(shotURL.path) Looks like Bob is still unable to respond to chats."
    let result = WorkspaceImageAttachment.extractInlineLocalImages(from: raw, limit: 4)
    XCTAssertEqual(result.attachments.count, 1)
    XCTAssertEqual(result.attachments.first?.name, "CleanShot 2026-11-18 at 15.10.04@2x.png")
    XCTAssertEqual(result.cleanedText, "Looks like Bob is still unable to respond to chats.")
  }

  func testExtractInlineIgnoresMissingFilesAndRemoteURLs() {
    let text = "Check https://example.com/fake.png and /tmp/does-not-exist-\(UUID().uuidString).png please"
    let result = WorkspaceImageAttachment.extractInlineLocalImages(from: text, limit: 4)
    XCTAssertTrue(result.attachments.isEmpty)
    XCTAssertEqual(result.cleanedText, text)
  }

  func testCommandVPasteboardPrefersImageButKeepsProsePasteIntact() throws {
    let tempDir = FileManager.default.temporaryDirectory
      .appendingPathComponent("PasteTest-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: tempDir) }

    let shotURL = tempDir.appendingPathComponent("shot.png")
    try makeTestPNG(at: shotURL)

    let pb = NSPasteboard(name: .init("openagi-test-\(UUID().uuidString)"))
    defer { pb.releaseGlobally() }

    // Plain prose text must NOT be intercepted as an image paste
    pb.clearContents()
    pb.setString("Looks like Bob is still broken in staging", forType: .string)
    XCTAssertTrue(WorkspaceImageAttachment.pasteboardImagesForCommandV(pb).isEmpty)

    // String pointing to a local screenshot file MUST resolve to an image
    pb.clearContents()
    pb.setString(shotURL.path, forType: .string)
    XCTAssertEqual(WorkspaceImageAttachment.pasteboardImagesForCommandV(pb).count, 1)

    // Raw PNG pasteboard data MUST resolve to an image
    pb.clearContents()
    let pngData = try Data(contentsOf: shotURL)
    pb.setData(pngData, forType: .png)
    XCTAssertEqual(WorkspaceImageAttachment.pasteboardImagesForCommandV(pb).count, 1)
  }
}
