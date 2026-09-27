import SwiftUI

// DESIGN.md's Chat section: "Assistant replies render Markdown -- bold,
// inline code, fenced code blocks, bullet and numbered lists, links. A reply
// full of raw `**asterisks**` is the clearest possible sign the app does not
// understand its own content." No third-party dependencies are allowed (see
// mobile/ios's build constraints), and SwiftUI's own
// `AttributedString(markdown:)` only ever handles *inline* spans -- it has
// no concept of block structure (paragraphs, lists, code fences), and a
// `Text` built from a "full" parse still renders every block as one run of
// characters with no bullets, numbers, or fences. This file supplies the
// missing block layer by hand: split the raw text into ordered blocks first,
// then hand each block's inline text to `AttributedString(markdown:)` for
// bold/code/link spans only.
public enum MarkdownBlock: Equatable {
    case paragraph(String)
    case bulletList([String])
    case numberedList([String])
    case codeBlock(language: String?, code: String)
}

public enum MarkdownParser {
    // Line-based block splitter. Deliberately simple: this is chat prose
    // from one model, not arbitrary CommonMark input, so it covers exactly
    // what DESIGN.md asks for -- paragraphs, fenced code, and the two list
    // styles -- rather than the full spec (block quotes, tables, nested
    // lists, setext headings, etc).
    public static func parse(_ text: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
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
                if index < lines.count { index += 1 } // consume the closing fence, if the text had one
                blocks.append(.codeBlock(language: language.isEmpty ? nil : language, code: codeLines.joined(separator: "\n")))
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

    // Inline-only: bold, italic, inline code spans, and links. Never touches
    // block structure -- that has already been decided above.
    public static func inline(_ raw: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: raw, options: options)) ?? AttributedString(raw)
    }
}

// DESIGN.md: "Fenced code uses the mono face on a subtly darker fill,
// scrolls horizontally rather than wrapping, and is long-press copyable."
// Reuses `Theme.edge` (the hairline colour) as that "subtly darker fill"
// rather than inventing a seventh palette value -- DESIGN.md's Colour
// section is explicit that the palette is "six values per mode. Nothing
// else."
struct CodeBlockView: View {
    let code: String

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(code)
                .font(Theme.Typography.dataMono)
                .foregroundStyle(Theme.ink)
                .padding(Theme.Spacing.x3)
        }
        .background(Theme.edge)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .contextMenu {
            Button {
                UIPasteboard.general.string = code
            } label: {
                Label("Copy", systemImage: "doc.on.doc")
            }
        }
    }
}

// Renders a full assistant reply: an ordered stack of blocks, each drawn per
// DESIGN.md's Chat section.
struct MarkdownContent: View {
    let blocks: [MarkdownBlock]

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.x2) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
    }

    @ViewBuilder
    private func blockView(_ block: MarkdownBlock) -> some View {
        switch block {
        case .paragraph(let raw):
            Text(MarkdownParser.inline(raw))
                .font(Theme.Typography.body)
                .foregroundStyle(Theme.ink)
        case .bulletList(let items):
            VStack(alignment: .leading, spacing: Theme.Spacing.x1) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    listRow(marker: "\u{2022}", raw: item)
                }
            }
        case .numberedList(let items):
            VStack(alignment: .leading, spacing: Theme.Spacing.x1) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    listRow(marker: "\(index + 1).", raw: item)
                }
            }
        case .codeBlock(_, let code):
            CodeBlockView(code: code)
        }
    }

    private func listRow(marker: String, raw: String) -> some View {
        HStack(alignment: .top, spacing: Theme.Spacing.x2) {
            Text(marker)
                .font(Theme.Typography.body)
                .foregroundStyle(Theme.muted)
            Text(MarkdownParser.inline(raw))
                .font(Theme.Typography.body)
                .foregroundStyle(Theme.ink)
        }
    }
}
