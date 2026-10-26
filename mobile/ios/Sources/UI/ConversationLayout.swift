import SwiftUI

// Keep both children in the same layout across folds, so the text field
// retains its identity and focus. In a book, history and input get their own
// pages; in tabletop, history stays above the fold and input below it.
struct ConversationLayout: Layout {
    var division: CGRect?
    var rightToLeft = false

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        proposal.replacingUnspecifiedDimensions()
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard subviews.count == 2 else { return }
        let regions = ConversationRegions(size: bounds.size, division: division, rightToLeft: rightToLeft)
        let inputSize = subviews[1].sizeThatFits(.init(width: regions.input.width, height: nil))
        let inputHeight = min(inputSize.height, regions.input.height)
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
