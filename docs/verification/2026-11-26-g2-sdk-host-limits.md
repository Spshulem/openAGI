# G2 SDK, host and firmware limits (research, 2026-11-26)

Scope: Even Hub plugin `integration-clients/even-g2-overlay/` (Agents 0.5.9) and
the native Even AI agent path (`src/integrations/g2-agent.js`,
`POST /nodes/g2/chat/completions`). Desk research only; no hardware was touched.

Labels: **D** = Documented (official Even source, URL given) · **C** = Community
measurement (non-official, URL given) · **R** = Repo-recorded (file given) ·
**I** = Inferred · **U** = Unknown / not published.

Official sources consulted (accessed 2026-11-26; "last updated" as shown on page):

| Key | URL | Last updated |
| --- | --- | --- |
| LIFE | https://hub.evenrealities.com/docs/build/page-lifecycle | n/a |
| BG | https://hub.evenrealities.com/docs/build/background-lifecycle | 2026-06-22 |
| DEV | https://hub.evenrealities.com/docs/build/device-apis | n/a |
| DISP | https://hub.evenrealities.com/docs/build/display | 2026-10-09 |
| MENU | https://hub.evenrealities.com/docs/build/contextual-menu | n/a |
| QA | https://hub.evenrealities.com/docs/ship/app-submission | n/a |
| FAQ | https://hub.evenrealities.com/docs/reference/faq | 2026-10-09 |
| CHG | https://hub.evenrealities.com/docs/reference/changelog | 2026-10-20 |
| VER | https://hub.evenrealities.com/docs/reference/versioning | 2026-08-25 |
| NPM | `npm view @evenrealities/even_hub_sdk` + installed package README/`index.d.ts` (0.0.16) | 2026-09-24 |
| STORE | https://apps.apple.com/us/app/even-realities/id6747017725 | 2.4.1 entry Nov 18 |
| BYOA | https://support.evenrealities.com/hc/en-us/articles/16280926743695-Tutorial-Bridging-G2-to-OpenClaw-Bring-Your-Own-Agent (403 to direct fetch; content via search snippet) | n/a |

## 1. Versions

| Item | Value | Label / source |
| --- | --- | --- |
| Even Hub SDK `@evenrealities/even_hub_sdk` latest | **0.0.16** (2026-09-24); no newer release on npm as of 2026-11-26 | D: NPM, CHG |
| SDK pinned in `package.json` | **0.0.16** (exact) — current | R: `integration-clients/even-g2-overlay/package.json` |
| SDK 0.0.16 min Even app (`minAppVersion`) | 2.2.10 | D: NPM package.json/README |
| `@evenrealities/evenhub-cli` | latest **0.2.0** (2026-10-20); pinned **0.1.13** (2026-04-20) — 0.1.14+ auto-stamps `min_app_version` | D: CHG, NPM; R: package.json |
| `@evenrealities/evenhub-simulator` | latest **0.9.5** (2026-09-01); pinned **0.8.0** — 0.9.0+ needed to simulate long press/context menu, 0.9.1+ for long-press automation | D: CHG; R: package.json |
| Even Realities app (iOS) current | **2.4.1** (Nov 18); 2.4.0 (Oct 27), 2.3.3 (Oct 21, "lower battery drain, especially in background"), 2.3.2 (Oct 2, customizable long-press shortcuts, "better background connection on certain phones"), 2.3.1 (Sep 21, iOS reconnection), 2.3.0 (Sep 15, "improved Even Hub plug-in reliability"), 2.2.10 (Sep 2) | D: STORE |
| G2 / R1 firmware | Only public number: "new Even AI experience requires firmware **v2.4.0** on both Even G2 and Even R1" (app 2.4.0 notes). 2.3.2 required "latest" firmware without a number. No firmware changelog published. | D: STORE; U: exact current build |
| SDK ↔ firmware table | Not published; `min_sdk_version` in `app.json` acts as firmware floor | D: VER |
| Repo-recorded device versions | None. Every verification doc lists "record phone OS, Even app and glasses firmware" as a pending physical step; no recorded values | R: `docs/verification/2026-09-12-g2-experience.md` §Physical acceptance item 7 |

## 2. Native Even AI custom agent ("Add Agent")

| Aspect | Finding | Label |
| --- | --- | --- |
| Exists officially? | Yes, as a developer feature: Settings → Even AI → Agent Configuration, "only visible to EvenHub developers". Official tutorial targets OpenClaw `…/v1/chat/completions` with an API key. Not in hub.evenrealities.com SDK docs; no formal spec. | D: BYOA |
| Request | `POST` to exact configured URL (no path appended), `Authorization: Bearer <token>`, `Content-Type: application/json`, extra `x-openclaw-agent-id: main`; body `{"model":"openclaw","messages":[{"role":"user","content":"<transcript>"}]}`; no system message; UA `EvenCore/1.0` or `Dart/3.8` depending on build | C: github.com/kucau0901/even-g2-agent-adapter, github.com/fuschini/eveng2-agent-poc |
| Streaming | App never sets `stream`, does not read SSE | C: kucau0901 |
| Response | OpenAI `chat.completion`; displays `choices[0].message.content` | C: fuschini |
| Timeout | Conflicting: ~30 s (fuschini) vs ~300 s FIN at 299 s (kucau0901) | C |
| Display limit | ~400–500 chars rendered then "Struggling to render more…"; unsupported glyphs/markdown corrupt lines | C: kucau0901 |
| Selection | Saving does not select; tap the agent name to activate | C: kucau0901; R: `docs/setup/even-g2.md` "Save, select, and activate" |
| Even AI 2.0 (app/firmware 2.4.0) | Multi-turn without re-wake; hold touch sensor to talk to Even AI | D: STORE; press: 9to5google.com/2026/10/26/... |
| Our adapter | One user message ≤4000 chars, rejects `stream:true`, dedupes identical utterance (60 s window), 55 s server timeout, reply cleaned to **12 000 chars** | R: `src/integrations/g2-agent.js`; `docs/setup/even-g2-agent-contract.md` |
| Gap | Reply cap (12 000) far exceeds the ~400–500 char on-glasses render limit; Even AI owns mic/wake/display, so no Lifelog, no quiet display, no clock on this path | I |

## 3. Foreground, background, phone lock, BLE

| Question | Finding | Label |
| --- | --- | --- |
| iOS, Even app backgrounded | "WebView keeps running. In-memory JS state survives." | D: BG |
| Android, backgrounded | WebView "may be suspended under memory pressure"; treat as cold start | D: BG |
| FAQ (contradicts BG for iOS) | "WebView is suspended on background; in-flight requests stall"; WebSockets "expect drops"; "Plugins are foreground-only on the glasses" | D: FAQ |
| Microphone in background | "Stops if the WebView is suspended"; re-enable on foreground, "don't assume the stream is still live" | D: BG |
| Keep-alive | Only mention: SDK 0.0.10 "Enhanced/Stronger WebView background keep-alive". No API, no background-audio entitlement documented | D: NPM, CHG |
| 5-minute lock | QA test: install as **beta** build, "lock the phone for 5 minutes — does the app stay alive and responsive?"; also "after 2 minutes idle still alive", "unlock → other app → re-lock — glasses session unaffected", core flow must run on glasses + ring input alone while locked. Beta builds "survive a locked phone"; **QR sideload dies when the WebView backgrounds** | D: QA, BG |
| Display updates / input while locked | Implied supported (QA expects rendering and ring/glasses-driven core flow while locked) | I from D: QA |
| Continuous mic across 5-min lock | Not stated by Even. Repo's own lock test (lock 5 min, phrase each minute, verify saved on main) is **not yet verified** | U; R: `integration-clients/even-g2-overlay/README.md` §0.4.14 |
| BLE reconnect | No SDK doc. `onDeviceStatusChanged` reports `connectType`; app 2.3.1/2.3.2 notes improved iOS reconnection / background connection. Whether mic or page survives a BLE drop: undocumented | D: NPM, STORE; U |
| Context-menu side effect | Opening the system menu fires `FOREGROUND_ENTER_EVENT`, closing fires `FOREGROUND_EXIT_EVENT`; exit "does not mean your app was torn down" | D: MENU |
| Our handling | `FOREGROUND_EXIT_EVENT` → `foreground(false)`, which stops the mic locally (README 0.5.0: "Leaving the glasses foreground only stops the microphone locally; any gesture or foreground return starts it again"; "phone screen being locked no longer pauses anything"). So opening the system menu likely pauses Lifelog briefly | R: `src/openagi/input-controller.ts`, README; I |
| Repo note | "Even's background guide and FAQ disagree about suspension/network behavior" — still true | R: README §0.4.14 |

## 4. Input gestures

| Gesture | Event | Notes | Label |
| --- | --- | --- | --- |
| Single press/tap | `CLICK_EVENT` (0) | May arrive as `undefined` | D: DEV |
| Double press/tap | `DOUBLE_CLICK_EVENT` (3) | **Root page must call `shutDownPageContainer(1)`** (or open an in-app menu whose Exit item does); silent/no-op double-tap is rejected. No rule for child pages | D: QA, LIFE |
| Swipe up / down | `SCROLL_TOP_EVENT` (1) / `SCROLL_BOTTOM_EVENT` (2) | Also fire at scroll boundaries | D: DEV |
| Long press / release | `LONG_PRESS_EVENT` (9) / `LONG_PRESS_RELEASE_EVENT` (10) | SDK 0.0.14+, app 2.2.9+; always on `sysEvent`. Treat as enhancement, not sole path | D: DEV, FAQ |
| Tap then long press | (system) | **Reserved**: raises OS contextual menu | D: DEV, MENU, FAQ |
| Ring (R1) | Same set, distinguishable by source | Conflict: DEV says `eventSource` absent on long press; SDK 0.0.15 README says long-press `sysEvent` preserves `eventSource` (GLASSES_R / RING / GLASSES_L) | D: DEV vs NPM |
| Other "double-press" | None. "Double press" in the docs **is** `DOUBLE_CLICK_EVENT`; there is no separate temple double-press or triple-tap | D: DEV |
| System long-press shortcuts | App 2.3.2 adds customizable long-press shortcuts; 2.4.0 hold touch sensor to start Even AI. FAQ: a press "only reaches you when your layer owns it" | D: STORE, FAQ; I: may compete outside the plugin |
| Our mapping | Talk/Lifelog/Supervisor: tap, swipe up Inbox, swipe down controls/Recent, **double-tap = native exit at root, Back on child screens**; hold = one tap or Supervisor push-to-talk | R: README §0.5.0, §0.4.17; `src/openagi/input-controller.ts` |

## 5. Display

| Item | Finding | Label |
| --- | --- | --- |
| Canvas | 576 × 288 per eye, 4-bit greyscale (16 greens), black = transparent/off | D: DISP |
| Containers | ≤4 image + ≤8 other per page (SDK enforces `containerTotalNum` 1–12, text ≤8); exactly one `isEventCapture: 1` | D: DISP, NPM |
| Text | create/rebuild ≤1000 chars, `textContainerUpgrade` ≤2000; full-screen fits ~400–500 chars; one non-monospaced font, no size/alignment; `textColor` 0–4 (0 "may render effectively invisible") | D: DISP |
| Images | ≤288 × 144 per container; 100 ms pacing floor per send; ~800 ms full-screen refresh | D: DISP, FAQ |
| Update rate | Text upgrade is "flicker-free"; rebuild flickers and loses state. No published text rate limit; plan animation around ~800 ms | D: DISP, LIFE, FAQ |
| Blank screen | No blank API; render `' '` (transparent). OS contextual menu has a system **"Display off"** slot (top, not SDK-reachable) | D: DISP, MENU |
| Clock | No system clock/status bar for plugins documented; plugin must draw it. Ours draws a static `HH:MM` in a status container (upper right), updated only on change, no animation | U (system); R: `src/openagi/display-controller.ts` |
| Listening indicator | Not documented as system-drawn; ours is app-drawn (`●` 32×32 at (540,4) in quiet Lifelog) | U; R: README §0.4.13, §0.4.9 |
| Menu | ≤10 custom items, name ≤32 UTF-8 bytes, fire-and-forget; system adds Display off, Brightness, Close [app] | D: MENU, NPM |

## 6. Microphone

| Item | Finding | Label |
| --- | --- | --- |
| API | `audioControl(true, AudioInputSource.Glasses \| Phone)`; PCM via `onEvenHubEvent` → `audioEvent.audioPcm` (`Uint8Array`) plus `source`, `direction`, `speakerRole` (0.0.14+) | D: DEV, NPM |
| Format | PCM 16 kHz, signed 16-bit LE, mono (both sources) | D: DEV |
| Glasses mic prerequisite | `createStartUpPageContainer` must run first | D: DEV, NPM |
| Frame size | Not specified | U |
| Continuous capture / duration cap | Capture runs while `audioControl(true)` is held; no cap documented; stops on WebView suspension | D: FAQ, BG; U: cap |
| Permissions | `g2-microphone` / `phone-microphone` in `app.json` | D: DEV, QA |
| Our handling | 640-byte chunks paced at 32 KB/s; 8 s without PCM = stop; reconnect ≤3/min; no catch-up of late audio | R: README §0.4.11, §0.4.14 |

## Implications for current work

1. **Continuous Lifelog**: officially possible only while the WebView is live
   and the plugin is foreground on the glasses; no background-audio contract.
   Distribute as a beta/store build (QR sideload dies on background). (D + I)
2. **5-min lock**: Even's own QA expects a beta build to stay alive and
   responsive after 5 minutes locked, but does not promise mic continuity; on
   Android expect cold start. Our lock test is still unverified. (D, R)
3. **Quiet-display toggle**: a double-press on the root page is the mandated
   exit gesture, and there is no other double gesture. Options that avoid the
   conflict: a custom contextual-menu item (tap-then-long-press → "Quiet
   display"), a swipe/child-screen action, or long press (enhancement only;
   may be claimed by system shortcuts). The system menu already offers
   "Display off". Ring-source double-tap might be distinguishable, but QA rules
   do not exempt the ring. (D + I)
4. **Static clock**: allowed and app-drawn (text upgrade, minute granularity,
   flicker-free). No system clock exists for plugins; it disappears if the
   WebView is suspended. (D + R + I)
5. **Context menu**: opening it fires FOREGROUND_EXIT; our controller stops the
   mic on that event, so using a menu item for quiet display would also pause
   capture unless the handler distinguishes "overlay closed" from "user left". (D + R + I)

## Decisions in this change, and hardware checks still pending

Decided from the findings above:
- Quiet Supervisor display does **not** use double-press: root double-tap stays
  Even's exit dialog. It is entered from the phone, or by swiping past the last
  Supervisor status page, and wakes on tap, swipe, or a new actionable
  Supervisor item. The system menu's "Display off" is not used because opening
  that menu fires FOREGROUND_EXIT, which stops the microphone.
- The status line is a still, app-drawn clock (minute updates only, no
  animation). Active capture shows the clock alone; "Checking…", "Mic off" and
  "Paused" are the only words added.
- Lifelog listens continuously while Agents is foreground on the glasses and
  the WebView is live. After a locked-phone audio gap it retries with backoff
  (15 s doubling to 5 min) instead of waiting for a gesture.

Not yet run on hardware (no G2 available to this session). Each needs an actual
G2 + phone, recording the Even app, firmware and SDK versions shown in Settings:

| Check | Expected | Status |
| --- | --- | --- |
| Mic samples: Lifelog on, speak for 60 s | 16 kHz s16le mono PCM arrives continuously; no "Mic off" | Not run |
| Speech session/socket: relay to main for 10 min | One socket, no reconnect loop; final text saved on main | Not run |
| Phone locked 5 min, glasses foreground | Record whether audio keeps arriving; if not, "Mic off" then automatic resume within the backoff after unlock | Not run |
| Even app backgrounded / BLE reconnect | Mic stops locally, consent unchanged, resumes on return | Not run |
| Native Even AI agent with phone locked | Records whether "Hey Even" still reaches OpenAGI | Not run |
| Quiet display + new Supervisor card | Display wakes once for a new actionable card, not for an old or repeated one | Not run |
| Consent on glasses | Swipe down → Give recording consent → confirm starts listening; Stop withdraws | Not run |
| Static clock | Updates once a minute, no flicker, no Listening banner | Not run |
