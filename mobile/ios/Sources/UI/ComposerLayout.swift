import SwiftUI

// Stable children (the field always second) keep the native editor and its selection alive when
// a fold or Dynamic Type moves the controls onto their own row.
struct ComposerLayout: Layout {
    var prefersSeparateControls: Bool
    var rightToLeft: Bool
    private let control: CGFloat = 44
    private let gap: CGFloat = 8

    // Subviews: the leading control, the field, then one or more trailing
    // controls (dictation, Supervisor voice, Send). Every control keeps one
    // line with a field still worth typing in; Duo's cover screen, beside its
    // trailing rail, is just under 360.
    private func controls(_ subviews: Subviews) -> Int { subviews.count - 1 }

    private func separatesControls(at width: CGFloat, controls: Int) -> Bool {
        prefersSeparateControls || width < CGFloat(controls) * (control + gap) + 140
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard subviews.count >= 3 else { return .zero }
        let count = controls(subviews)
        let width = proposal.width ?? 360
        let separate = separatesControls(at: width, controls: count)
        let fieldWidth = separate ? width : max(0, width - CGFloat(count) * (control + gap))
        let field = subviews[1].sizeThatFits(.init(width: fieldWidth, height: nil))
        return CGSize(width: width, height: separate ? field.height + gap + control : max(field.height, control))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard subviews.count >= 3 else { return }
        let count = controls(subviews)
        let trailing = count - 1
        let separate = separatesControls(at: bounds.width, controls: count)
        let fieldWidth = separate ? bounds.width : max(0, bounds.width - CGFloat(count) * (control + gap))
        let fieldHeight = subviews[1].sizeThatFits(.init(width: fieldWidth, height: nil)).height
        let controlY = separate ? fieldHeight + gap : bounds.height - control
        var frames = [
            CGRect(x: 0, y: controlY, width: control, height: control),
            CGRect(x: separate ? 0 : control + gap, y: 0, width: fieldWidth, height: fieldHeight)
        ]
        // Trailing controls end at the trailing edge, in their given order.
        for index in 0..<trailing {
            let fromEnd = CGFloat(trailing - index)
            frames.append(CGRect(x: bounds.width - fromEnd * control - (fromEnd - 1) * gap, y: controlY, width: control, height: control))
        }
        for (index, frame) in frames.enumerated() {
            let x = rightToLeft ? bounds.width - frame.maxX : frame.minX
            subviews[index].place(at: CGPoint(x: bounds.minX + x, y: bounds.minY + frame.minY),
                                 anchor: .topLeading, proposal: .init(frame.size))
        }
    }
}
