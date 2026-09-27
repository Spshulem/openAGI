import SwiftUI

// DESIGN.md: "Rows sit on `surface` in grouped blocks with 12 corner radius
// and hairline separators between — not as individually floating cards
// with shadows. One radius value for row groups (12) ... No drop shadows
// anywhere; separation comes from the `canvas`/`surface` contrast and
// hairlines." This is a `ViewBuilder`, not a `List`, so screens that need
// a plain grouped block (not a scrolling table) — the pairing form, a
// detail screen's fields — can use exactly this look too.
public struct RowGroup<Content: View>: View {
    @ViewBuilder let content: Content

    public init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    public var body: some View {
        VStack(spacing: 0) { content }
            .background(Theme.surface)
            .clipShape(RoundedRectangle(cornerRadius: Theme.rowGroupRadius, style: .continuous))
    }
}

// A hairline separator matching `edge`, inset the way a grouped table's
// separator would be (left-aligned to content, not full-bleed).
public struct RowHairline: View {
    let leadingInset: CGFloat

    public init(leadingInset: CGFloat = Theme.Spacing.x4) {
        self.leadingInset = leadingInset
    }

    public var body: some View {
        Theme.edge
            .frame(height: Theme.hairlineWidth)
            .padding(.leading, leadingInset)
    }
}

// DESIGN.md: "Empty state. Centred, a single line of `ink` plus a line of
// `muted`. No illustration, no icon larger than 28pt."
public struct EmptyStateView: View {
    let headline: String
    let detail: String

    public init(headline: String, detail: String) {
        self.headline = headline
        self.detail = detail
    }

    public var body: some View {
        VStack(spacing: Theme.Spacing.x2) {
            Text(headline)
                .font(Theme.Typography.body)
                .foregroundStyle(Theme.ink)
            Text(detail)
                .font(Theme.Typography.secondary)
                .foregroundStyle(Theme.muted)
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .padding(.vertical, Theme.Spacing.x8)
    }
}
