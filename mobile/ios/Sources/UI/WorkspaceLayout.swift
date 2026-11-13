import SwiftUI

// Keep the navigation container alive as the hinge changes orientation.
// Navigation stays native; only the optional supporting chat is positioned.
struct WorkspaceLayout: Layout {
    var division: CGRect?
    var rightToLeft = false

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        proposal.replacingUnspecifiedDimensions()
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let regions = WorkspaceRegions(size: bounds.size, division: division,
                                       showsChat: subviews.count > 1, rightToLeft: rightToLeft)
        for (index, frame) in [regions.primary, regions.chat].enumerated() {
            guard index < subviews.count else { continue }
            subviews[index].place(at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                                 anchor: .topLeading, proposal: .init(width: frame.width, height: frame.height))
        }
    }
}

struct WorkspaceRegions {
    let primary: CGRect
    let chat: CGRect

    init(size: CGSize, division: CGRect?, showsChat: Bool, rightToLeft: Bool = false) {
        let full = CGRect(origin: .zero, size: size)
        guard showsChat else { primary = full; chat = .zero; return }
        if let fold = division?.intersection(full), !fold.isNull,
           fold.height > fold.width, fold.minX > 0, fold.maxX < size.width {
            let left = CGRect(x: 0, y: 0, width: fold.minX, height: size.height)
            let right = CGRect(x: fold.maxX, y: 0, width: size.width - fold.maxX, height: size.height)
            primary = rightToLeft ? right : left
            chat = rightToLeft ? left : right
        } else if let fold = division?.intersection(full), !fold.isNull,
                  fold.width > fold.height, fold.minY > 0, fold.maxY < size.height {
            primary = CGRect(x: 0, y: 0, width: size.width, height: fold.minY)
            chat = CGRect(x: 0, y: fold.maxY, width: size.width, height: size.height - fold.maxY)
        } else {
            let chatWidth = min(480, size.width * 0.4)
            primary = CGRect(x: rightToLeft ? chatWidth : 0, y: 0, width: size.width - chatWidth, height: size.height)
            chat = CGRect(x: rightToLeft ? 0 : primary.maxX, y: 0, width: chatWidth, height: size.height)
        }
    }
}

enum DuoLayout {
    static func division(in geometry: GeometryProxy, layoutDirection: LayoutDirection) -> CGRect? {
        if #available(iOS 27.1, *) {
            return geometry.reservedRegions(kind: .division, layoutDirectionBehavior: .fixed).first.map { region in
                let frame = region.frame
                let left = layoutDirection == .rightToLeft ? region.margins.trailing : region.margins.leading
                return CGRect(x: frame.minX - left, y: frame.minY - region.margins.top,
                              width: frame.width + region.margins.leading + region.margins.trailing,
                              height: frame.height + region.margins.top + region.margins.bottom)
            }
        }
        return nil
    }
}
