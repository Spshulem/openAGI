import SwiftUI

// Four stable children keep the native editor and its selection alive when
// a fold or Dynamic Type moves the controls onto their own row.
struct ComposerLayout: Layout {
    var prefersSeparateControls: Bool
    var rightToLeft: Bool
    private let control: CGFloat = 44
    private let gap: CGFloat = 8

    private func separatesControls(at width: CGFloat) -> Bool {
        prefersSeparateControls || width < 360
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard subviews.count == 4 else { return .zero }
        let width = proposal.width ?? 360
        let separate = separatesControls(at: width)
        let fieldWidth = separate ? width : max(0, width - 3 * (control + gap))
        let field = subviews[1].sizeThatFits(.init(width: fieldWidth, height: nil))
        return CGSize(width: width, height: separate ? field.height + gap + control : max(field.height, control))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard subviews.count == 4 else { return }
        let separate = separatesControls(at: bounds.width)
        let fieldWidth = separate ? bounds.width : max(0, bounds.width - 3 * (control + gap))
        let fieldHeight = subviews[1].sizeThatFits(.init(width: fieldWidth, height: nil)).height
        let controlY = separate ? fieldHeight + gap : bounds.height - control
        let frames = [
            CGRect(x: 0, y: controlY, width: control, height: control),
            CGRect(x: separate ? 0 : control + gap, y: 0, width: fieldWidth, height: fieldHeight),
            CGRect(x: bounds.width - 2 * control - gap, y: controlY, width: control, height: control),
            CGRect(x: bounds.width - control, y: controlY, width: control, height: control)
        ]
        for (index, frame) in frames.enumerated() {
            let x = rightToLeft ? bounds.width - frame.maxX : frame.minX
            subviews[index].place(at: CGPoint(x: bounds.minX + x, y: bounds.minY + frame.minY),
                                 anchor: .topLeading, proposal: .init(frame.size))
        }
    }
}
