import Foundation
import ImageIO
import SwiftUI
import UniformTypeIdentifiers

enum ChatAttachmentPreparation {
    enum Failure: Error, LocalizedError {
        case unreadable, tooLarge
        var errorDescription: String? {
            switch self {
            case .unreadable: "Couldn't read this image. Choose another photo or image file."
            case .tooLarge: "This image is too large. Choose an image smaller than 32 MB."
            }
        }
    }

    static func prepare(_ data: Data, name: String) async throws -> ChatAttachment {
        try await Task.detached(priority: .userInitiated) {
            try encode(data, name: name)
        }.value
    }

    static func file(_ url: URL) async throws -> ChatAttachment {
        try await Task.detached(priority: .userInitiated) {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let values = try url.resourceValues(forKeys: [.fileSizeKey])
            guard (values.fileSize ?? 0) <= 32 * 1024 * 1024 else { throw Failure.tooLarge }
            return try encode(Data(contentsOf: url), name: url.lastPathComponent)
        }.value
    }

    private static func encode(_ data: Data, name: String) throws -> ChatAttachment {
        guard data.count <= 32 * 1024 * 1024 else { throw Failure.tooLarge }
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { throw Failure.unreadable }
        func jpeg(pixels: Int, quality: Double) throws -> Data {
            let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: pixels,
                kCGImageSourceShouldCacheImmediately: true]
            guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { throw Failure.unreadable }
            let result = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(result, UTType.jpeg.identifier as CFString, 1, nil) else { throw Failure.unreadable }
            CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
            guard CGImageDestinationFinalize(destination) else { throw Failure.unreadable }
            return result as Data
        }
        var original = try jpeg(pixels: 1600, quality: 0.82)
        if original.count > 768 * 1024 { original = try jpeg(pixels: 1280, quality: 0.65) }
        if original.count > 768 * 1024 { original = try jpeg(pixels: 960, quality: 0.5) }
        guard original.count <= 768 * 1024 else { throw Failure.tooLarge }
        let thumbnail = try jpeg(pixels: 180, quality: 0.6)
        let safeName = String(name.filter { $0.unicodeScalars.allSatisfy { !CharacterSet.controlCharacters.contains($0) } }.prefix(120))
        return ChatAttachment(name: safeName.isEmpty ? "Image.jpg" : safeName,
                              data: original.base64EncodedString(),
                              thumbnail: thumbnail.count <= 24 * 1024 ? thumbnail.base64EncodedString() : nil)
    }
}

struct ChatAttachmentImage: View {
    let attachment: ChatAttachment
    var fullSize = false

    var body: some View {
        if let encoded = fullSize ? (attachment.data ?? attachment.thumbnail) : (attachment.thumbnail ?? attachment.data),
           let data = Data(base64Encoded: encoded), let image = UIImage(data: data) {
            Image(uiImage: image).resizable().scaledToFit()
                .accessibilityLabel("Image: \(attachment.name)")
        } else {
            Label(attachment.name, systemImage: "photo")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}
