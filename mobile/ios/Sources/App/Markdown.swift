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
    // "## Plan" -- models reach for headings to structure longer replies;
    // shown as bold section text rather than a literal run of #'s.
    case heading(level: Int, text: String)
    case bulletList([String])
    case numberedList([String])
    case blockquote(String)
    case thematicBreak
    case table(headers: [String], rows: [[String]])
    case codeBlock(language: String?, code: String)
}

public enum MarkdownParser {
    // Line-based block splitter covering paragraphs, headings, lists,
    // blockquotes, thematic breaks, GFM pipe tables, and fenced code blocks.
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

            if let parsedTable = parseTable(from: lines, startIndex: index) {
                flushParagraph()
                flushList()
                blocks.append(.table(headers: parsedTable.headers, rows: parsedTable.rows))
                index = parsedTable.nextIndex
                continue
            }

            if let heading = headingText(line) {
                flushParagraph()
                flushList()
                blocks.append(.heading(level: heading.level, text: heading.text))
                index += 1
                continue
            }

            if isThematicBreak(line) {
                flushParagraph()
                flushList()
                blocks.append(.thematicBreak)
                index += 1
                continue
            }

            if line.hasPrefix(">") {
                flushParagraph()
                flushList()
                var quoteLines: [String] = []
                while index < lines.count {
                    let trimmedQuote = lines[index].trimmingCharacters(in: .whitespaces)
                    guard trimmedQuote.hasPrefix(">") else { break }
                    var body = trimmedQuote.dropFirst()
                    if body.first == " " { body = body.dropFirst() }
                    quoteLines.append(String(body))
                    index += 1
                }
                let joinedQuote = quoteLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
                if !joinedQuote.isEmpty {
                    blocks.append(.blockquote(joinedQuote))
                }
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

    private static func isThematicBreak(_ line: String) -> Bool {
        guard !line.isEmpty else { return false }
        let compact = line.filter { !$0.isWhitespace }
        guard compact.count >= 3, let marker = compact.first, marker == "-" || marker == "*" || marker == "_" else {
            return false
        }
        return compact.allSatisfy { $0 == marker }
    }

    private static func parseTable(from lines: [String], startIndex: Int) -> (headers: [String], rows: [[String]], nextIndex: Int)? {
        guard startIndex + 1 < lines.count else { return nil }
        let headerRaw = lines[startIndex].trimmingCharacters(in: .whitespaces)
        let sepRaw = lines[startIndex + 1].trimmingCharacters(in: .whitespaces)
        guard headerRaw.contains("|"), sepRaw.contains("|") else { return nil }
        let headers = parseTableCells(headerRaw)
        let separators = parseTableCells(sepRaw)
        guard !headers.isEmpty, headers.count == separators.count, separators.allSatisfy(isSeparatorCell) else {
            return nil
        }
        var rows: [[String]] = []
        var idx = startIndex + 2
        while idx < lines.count {
            let rowLine = lines[idx].trimmingCharacters(in: .whitespaces)
            guard !rowLine.isEmpty,
                  rowLine.contains("|"),
                  !rowLine.hasPrefix("```"),
                  !isThematicBreak(rowLine),
                  headingText(rowLine) == nil else {
                break
            }
            var cells = parseTableCells(rowLine)
            if cells.count < headers.count {
                cells.append(contentsOf: Array(repeating: "", count: headers.count - cells.count))
            } else if cells.count > headers.count {
                cells = Array(cells.prefix(headers.count))
            }
            rows.append(cells)
            idx += 1
        }
        return (headers, rows, idx)
    }

    private static func isSeparatorCell(_ cell: String) -> Bool {
        let trimmed = cell.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return false }
        var slice = trimmed[...]
        if slice.first == ":" { slice = slice.dropFirst() }
        if slice.last == ":" { slice = slice.dropLast() }
        return !slice.isEmpty && slice.allSatisfy { $0 == "-" }
    }

    private static func parseTableCells(_ raw: String) -> [String] {
        var content = raw.trimmingCharacters(in: .whitespaces)
        if content.hasPrefix("|") { content.removeFirst() }
        if content.hasSuffix("|"), !content.hasSuffix("\\|") { content.removeLast() }
        var cells: [String] = []
        var current = ""
        var escaped = false
        for ch in content {
            if escaped {
                if ch != "|" { current.append("\\") }
                current.append(ch)
                escaped = false
            } else if ch == "\\" {
                escaped = true
            } else if ch == "|" {
                cells.append(current.trimmingCharacters(in: .whitespaces))
                current.removeAll(keepingCapacity: true)
            } else {
                current.append(ch)
            }
        }
        if escaped { current.append("\\") }
        cells.append(current.trimmingCharacters(in: .whitespaces))
        return cells
    }

    private static func headingText(_ line: String) -> (level: Int, text: String)? {
        let hashes = line.prefix(while: { $0 == "#" }).count
        guard (1...6).contains(hashes) else { return nil }
        let rest = line.dropFirst(hashes)
        guard rest.first == " " else { return nil }
        let text = rest.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "#"))
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
    @Environment(\.chatFont) private var chatFont
    let blocks: [MarkdownBlock]

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.x2) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .lineLimit(nil)
        .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private func blockView(_ block: MarkdownBlock) -> some View {
        switch block {
        case .paragraph(let raw):
            Text(MarkdownParser.inline(raw))
                .font(chatFont)
                .foregroundStyle(Theme.ink)
        case .heading(let level, let raw):
            Text(MarkdownParser.inline(raw))
                .font(level <= 2 ? Theme.Typography.section : chatFont.weight(.semibold))
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
        case .blockquote(let raw):
            HStack(alignment: .top, spacing: Theme.Spacing.x2) {
                RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                    .fill(Theme.live.opacity(0.65))
                    .frame(width: 3)
                Text(MarkdownParser.inline(raw))
                    .font(chatFont)
                    .foregroundStyle(Theme.ink.opacity(0.9))
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, 2)
        case .thematicBreak:
            Rectangle()
                .fill(Theme.edge)
                .frame(height: 1)
                .padding(.vertical, 4)
        case .table(let headers, let rows):
            MarkdownTableView(headers: headers, rows: rows, font: chatFont)
        case .codeBlock(_, let code):
            CodeBlockView(code: code)
        }
    }

    private func listRow(marker: String, raw: String) -> some View {
        HStack(alignment: .top, spacing: Theme.Spacing.x2) {
            Text(marker)
                .font(chatFont)
                .foregroundStyle(Theme.muted)
            Text(MarkdownParser.inline(raw))
                .font(chatFont)
                .foregroundStyle(Theme.ink)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}

private struct MarkdownTableView: View {
    let headers: [String]
    let rows: [[String]]
    let font: Font

    var body: some View {
        ScrollView(.horizontal, showsIndicators: true) {
            Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(Array(headers.enumerated()), id: \.offset) { colIndex, header in
                        Text(MarkdownParser.inline(header))
                            .font(font.weight(.semibold))
                            .foregroundStyle(Theme.ink)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 7)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .overlay(alignment: .trailing) {
                                if colIndex + 1 < headers.count {
                                    Rectangle().fill(Theme.edge).frame(width: 1)
                                }
                            }
                    }
                }
                .background(Theme.edge.opacity(0.45))

                ForEach(Array(rows.enumerated()), id: \.offset) { rowIndex, row in
                    GridRow {
                        ForEach(0..<headers.count, id: \.self) { colIndex in
                            let cell = colIndex < row.count ? row[colIndex] : ""
                            Text(MarkdownParser.inline(cell))
                                .font(font)
                                .foregroundStyle(Theme.ink)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .overlay(alignment: .trailing) {
                                    if colIndex + 1 < headers.count {
                                        Rectangle().fill(Theme.edge).frame(width: 1)
                                    }
                                }
                        }
                    }
                    .background(rowIndex.isMultiple(of: 2) ? Color.clear : Theme.edge.opacity(0.18))
                    .overlay(alignment: .top) {
                        Rectangle().fill(Theme.edge).frame(height: 1)
                    }
                }
            }
            .background(Theme.surface)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(Theme.edge, lineWidth: 1)
            )
        }
    }
}
