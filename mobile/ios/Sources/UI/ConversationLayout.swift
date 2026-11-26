import SwiftUI

// Keep both children in the same layout across folds, so the text field
// retains its identity and focus. In a book, history and input get their own
// pages; in tabletop, history stays above the fold and input below it.
struct ConversationLayout: Layout {
    var division: CGRect?
    var rightToLeft = false
    /// Height of the history's fixed header (the Supervisor channel bar and
    /// banners above the messages), which the input must not cover.
    var reservedHistoryHeight: CGFloat = 0

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        proposal.replacingUnspecifiedDimensions()
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard subviews.count == 2 else { return }
        let regions = ConversationRegions(size: bounds.size, division: division, rightToLeft: rightToLeft)
        let inputSize = subviews[1].sizeThatFits(.init(width: regions.input.width, height: nil))
        let inputHeight = regions.inputHeight(ideal: inputSize.height, reservedHistory: reservedHistoryHeight) { room in
            subviews[1].sizeThatFits(.init(width: regions.input.width, height: room)).height
        }
        let historyHeight = regions.historyHeight ?? max(0, bounds.height - inputHeight)
        subviews[0].place(at: CGPoint(x: bounds.minX + regions.history.minX, y: bounds.minY + regions.history.minY), anchor: .topLeading,
                          proposal: .init(width: regions.history.width, height: historyHeight))
        subviews[1].place(at: CGPoint(x: bounds.minX + regions.input.minX,
                                     y: bounds.minY + regions.input.maxY - inputHeight), anchor: .topLeading,
                          proposal: .init(width: regions.input.width, height: inputHeight))
    }
}

struct ConversationRegions {
    let input: CGRect
    let history: CGRect
    let historyHeight: CGFloat?

    /// The input's height. On a fold each part has its own region. In one
    /// shared region the input grows up from the bottom over the history,
    /// and it used to take its whole ideal height: at the largest
    /// accessibility text on a phone, the expanded decision deck then drew
    /// over the Supervisor channel bar, so #needs-you could not be reached,
    /// and the messages were 0 pt tall. Now it stops below the history's
    /// fixed header (`reservedHistory`). `fitting` reports the input's
    /// height when offered `room`: flexible parts, such as the deck's
    /// scrolling details, give way first. Content that still cannot fit
    /// keeps its height, so the composer stays on screen.
    func inputHeight(ideal: CGFloat, reservedHistory: CGFloat, fitting: (CGFloat) -> CGFloat) -> CGFloat {
        let full = min(ideal, input.height)
        guard historyHeight == nil else { return full }
        let room = max(0, input.height - max(0, reservedHistory))
        guard full > room else { return full }
        return min(full, max(room, fitting(room)))
    }

    init(size: CGSize, division: CGRect?, rightToLeft: Bool = false) {
        let full = CGRect(origin: .zero, size: size)
        guard let fold = division, fold.intersects(full) else {
            input = full
            history = full
            historyHeight = nil
            return
        }
        if fold.height > fold.width, fold.minX > 0, fold.maxX < size.width {
            input = rightToLeft
                ? CGRect(x: 0, y: 0, width: fold.minX, height: size.height)
                : CGRect(x: fold.maxX, y: 0, width: size.width - fold.maxX, height: size.height)
            history = rightToLeft
                ? CGRect(x: fold.maxX, y: 0, width: size.width - fold.maxX, height: size.height)
                : CGRect(x: 0, y: 0, width: fold.minX, height: size.height)
            historyHeight = size.height
        } else if fold.width > fold.height, fold.minY > 0, fold.maxY < size.height {
            input = CGRect(x: 0, y: fold.maxY, width: size.width, height: size.height - fold.maxY)
            history = CGRect(x: 0, y: 0, width: size.width, height: fold.minY)
            historyHeight = fold.minY
        } else {
            input = full
            history = full
            historyHeight = nil
        }
    }
}
