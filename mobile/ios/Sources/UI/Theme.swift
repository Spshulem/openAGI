import SwiftUI

// The whole of mobile/DESIGN.md's palette and type scale, in one place, so
// every screen (and the widget, which compiles this same file into its own
// target — see project.yml) draws from the same six colours and the same
// scale rather than each screen inventing its own.
//
// Only Foundation/SwiftUI/UIKit here — this file compiles into the widget
// extension target too, which must not pull in networking or app-only
// frameworks.
public enum Theme {
    // MARK: - Colour

    // Screen background.
    public static let canvas = Color(light: 0xF1F3F2, dark: 0x0E1211)
    // Rows, cards, fields.
    public static let surface = Color(light: 0xFFFFFF, dark: 0x171C1A)
    // Primary text.
    public static let ink = Color(light: 0x13171A, dark: 0xECEFED)
    // Secondary text, hairlines' labels.
    public static let muted = Color(light: 0x5C6763, dark: 0x93A09A)
    // Connected, complete, confirm.
    public static let live = Color(light: 0x0E6F4E, dark: 0x4BC48D)
    // Overdue, deny, unreachable.
    public static let alert = Color(light: 0xA32C22, dark: 0xF08A7E)
    // Row-group separators.
    public static let edge = Color(light: 0xE2E6E4, dark: 0x262D2A)

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

    // System faces used deliberately: SF Pro on iOS. Sizes/weights below are
    // DESIGN.md's scale; each is exposed as a `Font` built with `.system` so
    // Dynamic Type still scales every one of these relative to the user's
    // chosen text size.
    public enum Typography {
        public static let screenTitle = Font.system(size: 34, weight: .semibold)
        public static let section = Font.system(size: 20, weight: .semibold)
        public static let body = Font.system(size: 17, weight: .regular)
        public static let secondary = Font.system(size: 15, weight: .regular)
        public static let caption = Font.system(size: 13, weight: .regular)
        // Monospace is reserved for machine identifiers: host, pairing code, ids.
        public static let dataMono = Font.system(size: 13, weight: .regular, design: .monospaced)
        public static let codeEntryMono = Font.system(size: 28, weight: .medium, design: .monospaced)
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
