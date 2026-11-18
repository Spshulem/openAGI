import AppKit
import SwiftUI

/// Native macOS 27 / iOS 27 design tokens aligned with `mobile/DESIGN.md` and
/// enhanced with macOS 26+ Liquid Glass primitives (`glassEffect`, `.glass`,
/// `.glassProminent`) while gracefully degrading on macOS 14–15.
enum WorkspaceTheme {
  static let canvas = Color.dynamic(light: 0xF1F3F2, dark: 0x0E1211)
  static let surface = Color.dynamic(light: 0xFFFFFF, dark: 0x171C1A)
  static let surfaceFill = Color.dynamic(light: 0xE6EBE8, dark: 0x202724)
  static let ink = Color.dynamic(light: 0x13171A, dark: 0xECEFED)
  static let muted = Color.dynamic(light: 0x5C6763, dark: 0x93A09A)
  static let live = Color.dynamic(light: 0x0E6F4E, dark: 0x4BC48D)
  static let alert = Color.dynamic(light: 0xA32C22, dark: 0xF08A7E)
  static let caution = Color.orange
  static let edge = Color.dynamic(light: 0xE2E6E4, dark: 0x262D2A)

  enum Spacing {
    static let x1: CGFloat = 4
    static let x2: CGFloat = 8
    static let x3: CGFloat = 12
    static let x4: CGFloat = 16
    static let x5: CGFloat = 20
    static let x6: CGFloat = 24
    static let x8: CGFloat = 32
  }

  static let cardRadius: CGFloat = 16
  static let groupRadius: CGFloat = 14
  static let pillRadius: CGFloat = 24
  static let bubbleRadius: CGFloat = 20

  enum Typography {
    static let screenTitle = Font.largeTitle.bold()
    static let section = Font.title3.weight(.semibold)
    static let headline = Font.headline
    static let body = Font.body
    static let chatBody = Font.system(size: 14.5)
    static let secondary = Font.subheadline
    static let caption = Font.caption
    static let dataMono = Font.caption.monospaced()
  }
}

private extension Color {
  static func dynamic(light: UInt32, dark: UInt32) -> Color {
    Color(nsColor: NSColor(name: nil) { appearance in
      let isDark = appearance.bestMatch(from: [.darkAqua, .vibrantDark, .aqua, .vibrantLight])
      let hex = (isDark == .darkAqua || isDark == .vibrantDark) ? dark : light
      return NSColor(
        srgbRed: CGFloat((hex >> 16) & 0xFF) / 255.0,
        green: CGFloat((hex >> 8) & 0xFF) / 255.0,
        blue: CGFloat(hex & 0xFF) / 255.0,
        alpha: 1.0
      )
    })
  }
}

extension View {
  @ViewBuilder
  func workspaceGlassCapsule(cornerRadius: CGFloat = WorkspaceTheme.pillRadius, focused: Bool = false) -> some View {
    let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
    if #available(macOS 26.0, *) {
      self
        .glassEffect(.regular, in: shape)
        .overlay(
          shape.strokeBorder(focused ? WorkspaceTheme.live.opacity(0.45) : Color.clear, lineWidth: 1)
        )
    } else {
      self
        .background(.ultraThinMaterial, in: shape)
        .overlay(
          shape.strokeBorder(focused ? WorkspaceTheme.live.opacity(0.55) : WorkspaceTheme.edge, lineWidth: 1)
        )
    }
  }

  func workspaceCardSurface(cornerRadius: CGFloat = WorkspaceTheme.cardRadius) -> some View {
    let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
    return self
      .background(WorkspaceTheme.surface, in: shape)
      .overlay(shape.strokeBorder(WorkspaceTheme.edge, lineWidth: 0.5))
  }
}

struct WorkspaceActionButton<Label: View>: View {
  var prominent: Bool = false
  var tintColor: Color? = nil
  var small: Bool = false
  let action: () -> Void
  @ViewBuilder let label: () -> Label

  var body: some View {
    if #available(macOS 26.0, *) {
      if prominent {
        sizedButton
          .buttonStyle(.glassProminent)
          .tint(tintColor ?? WorkspaceTheme.live)
      } else {
        sizedButton
          .buttonStyle(.glass)
      }
    } else {
      if prominent {
        sizedButton
          .buttonStyle(.borderedProminent)
          .tint(tintColor ?? WorkspaceTheme.live)
      } else {
        sizedButton
          .buttonStyle(.bordered)
      }
    }
  }

  @ViewBuilder
  private var sizedButton: some View {
    if small {
      Button(action: action, label: label).controlSize(.small)
    } else {
      Button(action: action, label: label)
    }
  }
}

struct WorkspaceRowGroup<Content: View>: View {
  @ViewBuilder let content: Content

  var body: some View {
    VStack(spacing: 0) { content }
      .workspaceCardSurface(cornerRadius: WorkspaceTheme.groupRadius)
  }
}

struct WorkspaceHairline: View {
  var leadingInset: CGFloat = WorkspaceTheme.Spacing.x4

  var body: some View {
    WorkspaceTheme.edge
      .frame(height: 0.5)
      .padding(.leading, leadingInset)
  }
}

// MARK: - Native Markdown Rendering (Shared with mobile/ios DESIGN.md)

enum WorkspaceMarkdownBlock: Equatable {
  case paragraph(String)
  case heading(level: Int, text: String)
  case bulletList([String])
  case numberedList([String])
  case codeBlock(language: String?, code: String)
}

enum WorkspaceMarkdownParser {
  static func parse(_ text: String) -> [WorkspaceMarkdownBlock] {
    var blocks: [WorkspaceMarkdownBlock] = []
    let lines = text.components(separatedBy: "\n")
    var paragraphLines: [String] = []
    var listItems: [String] = []
    var listIsOrdered = false

    func flushParagraph() {
      guard !paragraphLines.isEmpty else { return }
      let joined = paragraphLines.joined(separator: " ").trimmingCharacters(in: .whitespaces)
      if !joined.isEmpty { blocks.append(.paragraph(joined)) }
      paragraphLines.removeAll()
    }

    func flushList() {
      guard !listItems.isEmpty else { return }
      blocks.append(listIsOrdered ? .numberedList(listItems) : .bulletList(listItems))
      listItems.removeAll()
    }

    var index = 0
    while index < lines.count {
      let rawLine = lines[index]
      let line = rawLine.trimmingCharacters(in: .whitespaces)

      if line.hasPrefix("```") {
        flushParagraph()
        flushList()
        let language = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
        var codeLines: [String] = []
        index += 1
        while index < lines.count, !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
          codeLines.append(lines[index])
          index += 1
        }
        if index < lines.count { index += 1 }
        blocks.append(.codeBlock(language: language.isEmpty ? nil : language, code: codeLines.joined(separator: "\n")))
        continue
      }

      if let heading = headingText(line) {
        flushParagraph()
        flushList()
        blocks.append(.heading(level: heading.level, text: heading.text))
        index += 1
        continue
      }

      if let item = bulletItemText(line) {
        flushParagraph()
        if listIsOrdered { flushList() }
        listIsOrdered = false
        listItems.append(item)
        index += 1
        continue
      }

      if let item = numberedItemText(line) {
        flushParagraph()
        if !listIsOrdered { flushList() }
        listIsOrdered = true
        listItems.append(item)
        index += 1
        continue
      }

      if line.isEmpty {
        flushParagraph()
        flushList()
        index += 1
        continue
      }

      flushList()
      paragraphLines.append(line)
      index += 1
    }

    flushParagraph()
    flushList()
    return blocks
  }

  private static func headingText(_ line: String) -> (level: Int, text: String)? {
    let hashes = line.prefix(while: { $0 == "#" }).count
    guard (1...6).contains(hashes) else { return nil }
    let rest = line.dropFirst(hashes)
    guard rest.first == " " else { return nil }
    let text = rest
      .trimmingCharacters(in: .whitespaces)
      .trimmingCharacters(in: CharacterSet(charactersIn: "#"))
      .trimmingCharacters(in: .whitespaces)
    return text.isEmpty ? nil : (hashes, text)
  }

  private static func bulletItemText(_ line: String) -> String? {
    for marker in ["- ", "* ", "+ "] where line.hasPrefix(marker) {
      return String(line.dropFirst(marker.count))
    }
    return nil
  }

  private static func numberedItemText(_ line: String) -> String? {
    guard let dot = line.firstIndex(of: ".") else { return nil }
    let prefix = line[line.startIndex..<dot]
    guard !prefix.isEmpty, prefix.allSatisfy(\.isNumber) else { return nil }
    let afterDot = line.index(after: dot)
    guard afterDot < line.endIndex, line[afterDot] == " " else { return nil }
    return String(line[line.index(after: afterDot)...])
  }

  static func inline(_ raw: String) -> AttributedString {
    let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
    return (try? AttributedString(markdown: raw, options: options)) ?? AttributedString(raw)
  }
}

struct WorkspaceCodeBlockView: View {
  let language: String?
  let code: String
  @State private var copied = false

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 8) {
        Text((language?.isEmpty == false ? language! : "code").lowercased())
          .font(WorkspaceTheme.Typography.caption)
          .foregroundStyle(WorkspaceTheme.muted)
        Spacer()
        Button {
          NSPasteboard.general.clearContents()
          NSPasteboard.general.setString(code, forType: .string)
          copied = true
          Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.5))
            copied = false
          }
        } label: {
          Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
            .font(WorkspaceTheme.Typography.caption)
        }
        .buttonStyle(.plain)
        .foregroundStyle(copied ? WorkspaceTheme.live : WorkspaceTheme.muted)
      }
      .padding(.horizontal, WorkspaceTheme.Spacing.x3)
      .padding(.vertical, 6)
      .background(WorkspaceTheme.edge.opacity(0.65))

      ScrollView(.horizontal, showsIndicators: false) {
        Text(code)
          .font(WorkspaceTheme.Typography.dataMono)
          .foregroundStyle(WorkspaceTheme.ink)
          .textSelection(.enabled)
          .padding(WorkspaceTheme.Spacing.x3)
      }
    }
    .background(WorkspaceTheme.surfaceFill)
    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .strokeBorder(WorkspaceTheme.edge, lineWidth: 0.5)
    )
    .contextMenu {
      Button {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(code, forType: .string)
      } label: {
        Label("Copy code", systemImage: "doc.on.doc")
      }
    }
  }
}

struct WorkspaceMarkdownContent: View {
  let blocks: [WorkspaceMarkdownBlock]

  var body: some View {
    VStack(alignment: .leading, spacing: WorkspaceTheme.Spacing.x2) {
      ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
        blockView(block)
      }
    }
    .lineLimit(nil)
    .fixedSize(horizontal: false, vertical: true)
  }

  @ViewBuilder
  private func blockView(_ block: WorkspaceMarkdownBlock) -> some View {
    switch block {
    case let .paragraph(raw):
      Text(WorkspaceMarkdownParser.inline(raw))
        .font(WorkspaceTheme.Typography.chatBody)
        .foregroundStyle(WorkspaceTheme.ink)
        .textSelection(.enabled)
    case let .heading(level, raw):
      Text(WorkspaceMarkdownParser.inline(raw))
        .font(level <= 2 ? WorkspaceTheme.Typography.section : WorkspaceTheme.Typography.chatBody.weight(.semibold))
        .foregroundStyle(WorkspaceTheme.ink)
        .textSelection(.enabled)
        .padding(.top, 2)
    case let .bulletList(items):
      VStack(alignment: .leading, spacing: WorkspaceTheme.Spacing.x1) {
        ForEach(Array(items.enumerated()), id: \.offset) { _, item in
          listRow(marker: "\u{2022}", raw: item)
        }
      }
    case let .numberedList(items):
      VStack(alignment: .leading, spacing: WorkspaceTheme.Spacing.x1) {
        ForEach(Array(items.enumerated()), id: \.offset) { index, item in
          listRow(marker: "\(index + 1).", raw: item)
        }
      }
    case let .codeBlock(language, code):
      WorkspaceCodeBlockView(language: language, code: code)
    }
  }

  private func listRow(marker: String, raw: String) -> some View {
    HStack(alignment: .top, spacing: WorkspaceTheme.Spacing.x2) {
      Text(marker)
        .font(WorkspaceTheme.Typography.chatBody)
        .foregroundStyle(WorkspaceTheme.muted)
      Text(WorkspaceMarkdownParser.inline(raw))
        .font(WorkspaceTheme.Typography.chatBody)
        .foregroundStyle(WorkspaceTheme.ink)
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .fixedSize(horizontal: false, vertical: true)
  }
}
