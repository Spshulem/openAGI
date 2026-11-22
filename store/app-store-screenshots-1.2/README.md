# OpenAGI App Store screenshots (next version, 1.2)

Staged, not uploaded: 1.1 is live (READY_FOR_SALE) and its screenshots can't change;
upload these to the next editable version (1.2) once it exists.

- `APP_IPHONE_67/` — 7 slides, 1320×2868, opaque RGB (Apple scales to smaller iPhones).
- `APP_IPAD_PRO_3GEN_129/` — 6 slides, 2064×2752, opaque RGB.
- `contact-sheet.png` — both sets plus a 160 px thumbnail strip.
- `verification.json` — dimensions, color mode, SHA-256 per file.
- `editor-project.json` — deck state for the `app-store-screenshots` skill editor.

Provenance: raw captures are XCUITest screenshots (`StoreScreenshotTests.testCaptureSupervisorAgentScreens`)
of the shipping 1.1 (2142) views at commit 8b21839, with a DEBUG-only fictional fleet
(`StoreScreenshotFleet.swift`: invented projects, agents and PRs) and the phone paired with a Mac
(`--store-paired-mac`). Captured in CI on iPhone 17 Pro Max and iPad Pro 13-inch (iOS 27.2,
status bar 9:41). Framed and captioned with the `app-store-screenshots` skill editor
(Midnight Glow Pro theme) and exported through its Export bundle. No voice UI is shown.

Upload once 1.2 exists (dry run first):

    asc screenshots upload --app 6829464976 --version 1.2 --locale en-US --device-type IPHONE_67 --path APP_IPHONE_67 --replace --dry-run
    asc screenshots upload --app 6829464976 --version 1.2 --locale en-US --device-type IPAD_PRO_3GEN_129 --path APP_IPAD_PRO_3GEN_129 --replace --dry-run
