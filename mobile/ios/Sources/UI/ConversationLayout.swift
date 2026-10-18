import SwiftUI

// Keep both children in the same layout across folds, so the text field
// retains its identity and focus. Scrolling history can span a book's curve;
// the composer stays on the trailing page, or on the tabletop's lower half.
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
        subviews[0].place(at: bounds.origin, anchor: .topLeading,
                          proposal: .init(width: bounds.width, height: historyHeight))
        subviews[1].place(at: CGPoint(x: bounds.minX + regions.input.minX,
                                     y: bounds.minY + regions.input.maxY - inputHeight), anchor: .topLeading,
                          proposal: .init(width: regions.input.width, height: inputHeight))
    }
}

struct ConversationRegions {
    let input: CGRect
    let historyHeight: CGFloat?

    init(size: CGSize, division: CGRect?, rightToLeft: Bool = false) {
        let full = CGRect(origin: .zero, size: size)
        guard let fold = division, fold.intersects(full) else {
            input = full
            historyHeight = nil
            return
        }
        if fold.height > fold.width, fold.minX > 0, fold.maxX < size.width {
            input = rightToLeft
                ? CGRect(x: 0, y: 0, width: fold.minX, height: size.height)
                : CGRect(x: fold.maxX, y: 0, width: size.width - fold.maxX, height: size.height)
            historyHeight = nil
        } else if fold.width > fold.height, fold.minY > 0, fold.maxY < size.height {
            input = CGRect(x: 0, y: fold.maxY, width: size.width, height: size.height - fold.maxY)
            historyHeight = fold.minY
        } else {
            input = full
            historyHeight = nil
        }
    }
}
