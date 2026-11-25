import SwiftUI

// Preferences remain on this device. Scaled metrics preserve the user's
// accessibility text size in addition to the in-app size adjustment.
enum AppAppearance: String, CaseIterable, Identifiable {
    case system, light, dark, pureBlack
    var id: String { rawValue }
    var title: String {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        case .pureBlack: "Pure Black"
        }
    }
    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark, .pureBlack: .dark
        }
    }
}

private struct ChatFontKey: EnvironmentKey {
    static let defaultValue = Font.body
}
private struct CanvasKey: EnvironmentKey {
    static let defaultValue = Color(uiColor: .systemBackground)
}
extension EnvironmentValues {
    var chatFont: Font {
        get { self[ChatFontKey.self] }
        set { self[ChatFontKey.self] = newValue }
    }
    var appCanvas: Color {
        get { self[CanvasKey.self] }
        set { self[CanvasKey.self] = newValue }
    }
}

struct AppAppearanceModifier: ViewModifier {
    @AppStorage("appearance.theme") private var theme = AppAppearance.system
    @AppStorage("appearance.interfaceSize") private var interfaceSize = 15.0
    @AppStorage("appearance.chatSize") private var chatSize = 16.0
    @ScaledMetric(relativeTo: .body) private var textScale = 1.0
    @Environment(\.colorScheme) private var systemScheme

    func body(content: Content) -> some View {
        let dark = (theme.colorScheme ?? systemScheme) == .dark
        let canvas = dark ? (theme == .pureBlack ? Color.black : Color(white: 0.045)) : Color(uiColor: .systemGroupedBackground)
        content
            .preferredColorScheme(theme.colorScheme)
            .environment(\.appCanvas, canvas)
            .environment(\.chatFont, .system(size: min(24, max(14, chatSize)) * textScale))
            .font(.system(size: min(20, max(14, interfaceSize)) * textScale))
    }
}

struct AppearanceView: View {
    @AppStorage("appearance.theme") private var theme = AppAppearance.system
    @AppStorage("appearance.interfaceSize") private var interfaceSize = 15.0
    @AppStorage("appearance.chatSize") private var chatSize = 16.0
    @Environment(\.chatFont) private var chatFont
    @Environment(\.appCanvas) private var canvas

    var body: some View {
        Form {
            Section("Theme") {
                Picker("Appearance", selection: $theme) {
                    ForEach(AppAppearance.allCases) { choice in
                        Text(choice.title).tag(choice)
                    }
                }
                .accessibilityIdentifier("appearance-theme")
            }
            Section {
                Stepper("Interface: \(Int(interfaceSize)) pt", value: $interfaceSize, in: 14...20)
                Stepper("Chat: \(Int(chatSize)) pt", value: $chatSize, in: 14...24)
            } header: { Text("Text size") } footer: {
                Text("Interface size adjusts controls and labels. Chat size adjusts messages. Both scale with your iPhone’s accessibility text settings.")
            }
            Section("Preview") {
                Label("Today", systemImage: "sun.max")
                Text("Your next task is ready whenever you are.")
                    .font(chatFont)
                    .padding(.vertical, 8)
                Label("Connected · Just now", systemImage: "checkmark.circle")
                    .foregroundStyle(.secondary)
            }
            Section {
                Button("Use defaults") {
                    theme = .system
                    interfaceSize = 15
                    chatSize = 16
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(canvas)
        .navigationTitle("Appearance")
        .navigationBarTitleDisplayMode(.inline)
    }
}
