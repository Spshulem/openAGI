import SwiftUI

// System semantic colors and text styles follow iOS appearance, contrast and
// Dynamic Type settings. The app and widget share these native tokens.
public enum Theme {
    // MARK: - Colour

    // Screen background.
    public static let canvas = Color(uiColor: .systemGroupedBackground)
    // Rows, cards, fields.
    public static let surface = Color(uiColor: .secondarySystemGroupedBackground)
    // Primary text.
    public static let ink = Color.primary
    // Secondary text, hairlines' labels.
    public static let muted = Color.secondary
    // Connected, complete, confirm.
    public static let live = Color.blue
    // Overdue, deny, unreachable.
    public static let alert = Color.red
    // Row-group separators.
    public static let edge = Color(uiColor: .separator)
    // The Supervisor's intermediate health state.
    public static let caution = Color.orange

    // MARK: - Layout

    // 8pt spacing grid.
    public enum Spacing {
        public static let x1: CGFloat = 4
        public static let x2: CGFloat = 8
        public static let x3: CGFloat = 12
        public static let x4: CGFloat = 16
        public static let x5: CGFloat = 20
        public static let x6: CGFloat = 24
        public static let x8: CGFloat = 32
    }

    // Screen gutter.
    public static let gutter: CGFloat = 20
    // Row groups sit on `surface` with this one corner radius.
    public static let rowGroupRadius: CGFloat = 12
    // Rows are at least this tall so a thumb can hit them.
    public static let rowMinHeight: CGFloat = 60
    // The completion control's tap target, inside that row.
    public static let completionControlSize: CGFloat = 44
    public static let hairlineWidth: CGFloat = 1.0 / 3.0

    // MARK: - Type

    // Semantic text styles scale with Dynamic Type, including accessibility sizes.
    public enum Typography {
        public static let screenTitle = Font.largeTitle.bold()
        public static let section = Font.title3.weight(.semibold)
        public static let body = Font.body
        public static let secondary = Font.subheadline
        public static let caption = Font.caption
        // Monospace is reserved for machine identifiers: host, pairing code, ids.
        public static let dataMono = Font.caption.monospaced()
        public static let codeEntryMono = Font.title2.monospaced()
    }

    // Tracking for the pairing code field specifically — DESIGN.md calls for
    // "tracked +2" on that one field only.
    public static let codeEntryTracking: CGFloat = 2
}

extension Color {
    // A dynamic colour built from a light/dark pair of 0xRRGGBB literals,
    // resolved at draw time via the trait collection — this is what makes
    // every Theme colour above respond to Dark Mode automatically, on both
    // the app and the widget.
    init(light: UInt32, dark: UInt32) {
        self.init(uiColor: UIColor(dynamicLight: light, dark: dark))
    }
}

private extension UIColor {
    convenience init(dynamicLight light: UInt32, dark: UInt32) {
        self.init { trait in
            trait.userInterfaceStyle == .dark ? .init(hex: dark) : .init(hex: light)
        }
    }

    convenience init(hex: UInt32) {
        let r = CGFloat((hex >> 16) & 0xFF) / 255
        let g = CGFloat((hex >> 8) & 0xFF) / 255
        let b = CGFloat(hex & 0xFF) / 255
        self.init(red: r, green: g, blue: b, alpha: 1)
    }
}
