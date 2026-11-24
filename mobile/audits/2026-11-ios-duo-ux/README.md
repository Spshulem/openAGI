# iOS + iPhone Duo UX audit: Chat and Supervisor

Build audited: `origin/main` @ `1c7951fc` (after #281, #283, #345). This was a review only: no code changes. With the owner's approval, the build was installed on the owner's iPhone Duo for the on-device checks.
References used for design rules only: Apple HIG for iPhone (ehmo/platform-design-skills `skills/ios`) and SwiftUI Pro (`resizability.md`, `design.md`, `accessibility.md`, `navigation.md`).
Owner reference: the BoB and Claude Duet screenshots sent earlier, taken on an unfolded Duo (2853×2007).

## 1. What was verified where

| Surface | Standard iPhone | Duo cover | Duo unfolded |
|---|---|---|---|
| Chat: empty, history, keyboard, approval card, working line | **Simulator**: iPhone 18 Pro, iOS 27.0 | **Simulator**: iPhone Duo, iOS 27.1 | **Physical device**: iPhone Duo, iOS 27.3, inner display flat open in landscape |
| Supervisor: chips, decision card, composer, thread sheet, agent reply | Simulator | Simulator | Physical device: thread sheet, decision and agent reply; the Supervisor screen only behind sheets |
| Today, Inbox, Tasks, Settings | Simulator | Simulator | **Not run** on device. Settings tests can clear real credentials, so they were skipped |
| Dynamic Type at accessibility sizes | Simulator | Simulator | Not run |
| VoiceOver | **Not run** (labels read from code only) | Not run | Not run |
| Half-folded book or tabletop posture | n/a | n/a | **Not run** (the device was flat open) |
| UI tests (`NativeNavigationTests`) | 28/29 pass (the failure is the unrelated pairing test) | 29/29 pass | 9/9 selected Chat and Supervisor tests pass |

Device build: `main` @ `1c7951fc`, installed as OpenAGI 1.1 (build 2147), signed with Apple Development.

Device screenshots are from the physical Duo's inner display, rotated to landscape:
- `img/duo-unfolded-device-chat-approval.jpg`
- `img/duo-unfolded-device-chat-empty.jpg`
- `img/duo-unfolded-device-thread-decision.jpg`

The unfolded chat matches the owner's reference: conversation list on the left, chat on the right, approval card with Hide and Review. On the inner display, Supervisor chips run under the status column too (they show behind the thread sheet), so P1-3 also applies there.

Annotated screenshots:
- `img/duo-cover-supervisor-annotated.jpg`
- `img/iphone-supervisor-annotated.jpg`
- `img/duo-cover-thread-reply-annotated.jpg`

## 2. Prioritized findings

P1 means a decision could go wrong, or content is clipped. P2 is friction or a HIG violation. P3 is polish. Each "After" is a recommendation.

### P1-1. The Supervisor composer silently replies to whichever decision is on top
- **Before** (`img/duo-cover-supervisor-annotated.jpg` #2, `img/iphone-supervisor-annotated.jpg` #1): `syncFocusedCard()` (SupervisorView.swift:718) sets `focusedCardID` to the current card unless you cleared it. Every message then goes out with that card attached as `focusedCardId` (ChatConversation.swift:219 → agent-host.js:75). The placeholder says "Reply to decision **or** ask Supervisor…" and is cut off on both devices. The "Replying to: …" chip only appears once the field has focus. A general question can therefore be read as an answer to a decision.
- **Safety today:** the daemon uses the card id only as context. Sending to an agent goes through `fleet_send_message`, but for the authenticated owner that is **not always confirmed**: `ToolRegistry.ownerInvoke` (src/tool-registry.js) can approve and run it immediately. This happens when the owner's message reads as agreeing to, or choosing from, the previous assistant turn (`conversationalCover`), and for some voice requests. A separate confirmation only shows in the other cases. So an implicitly targeted message *can* reach an agent without another prompt, which makes this the most important fix.
- **After:** keep two explicit modes on the one composer.
  - **Ask Supervisor** is the default. Nothing is attached and nothing is selected automatically.
  - **Reply to "<decision>"** turns on only when you tap *Reply in chat* or pick the decision from a chip above the field. The chip stays visible, focused or not, and has a Clear button with a 44pt target.
  - Placeholders become "Ask Supervisor…" and "Reply to <short decision>…".
  - VoiceOver: the field's label includes the mode, and the chip is read as a button.

### P1-2. "Dismiss" means two different things on one card
- **Before** (`img/duo-cover-supervisor-annotated.jpg` #3 and #4):
  - **X** (SupervisorView.swift:2049): a 24×24 icon that sends `op: "dismiss"` straight away. No confirmation, no accessibility label.
  - **Grey "Dismiss" text** (SupervisorView.swift:2330): sends `card.secondaryAction`, which defaults to `op: "defer"` (Later). The code relabels "Later" as "Dismiss".
  - **"Hide ▾"**: only collapses the deck on this device.
  - So three controls look like dismissal and do three different things, and the obvious X is the irreversible one.
- **After:**
  - One overflow menu (`Menu("More", systemImage: "ellipsis.circle")`) holding **Later** (defer), **Dismiss…** (dismiss, with a confirmation that says what happens) and **Hide cards** (collapse locally).
  - The X disappears from the card.
  - The archive confirmation stays exactly as it is (`pendingArchiveConfirmation`, SupervisorView.swift:494).
  - Labels say what actually happens; "Later" is never shown as "Dismiss".

### P1-3. On the Duo cover, channel chips run under the system status column
- **Before** (`img/duo-cover-supervisor-annotated.jpg` #1): the clock overlaps the `#activity` chip.
- **After:** keep the chip row inside the safe area. HIG 1.2: don't ignore safe areas for content. SwiftUI Pro: vertical status bars on Duo. When the row overflows, show that it scrolls, or turn it into a menu at compact width.

### P1-4. Unfolded Duo: on-device checks done when flat open; half-folded posture still open
- **Verified on the physical Duo** (inner display, flat open, landscape):
  - The Chat split (list on the left, conversation and composer on the right) works.
  - The approval card works, and Hide and Review behave as designed.
  - Composer and keyboard: no freeze; this is the regression #283 fixed.
  - The thread sheet and its decision options work.
- **Still open:**
  - The book layout that sizes the conversation list to the left page (`ChatBookPages.sidebarWidth`) only applies when the device is half-folded. It was not exercised.
  - The Supervisor screen itself (chips, deck, composer) was seen only behind a sheet on the inner display.
- **After:** run §4 again in book and tabletop postures before calling the Duo layout accepted.

### P2-1. Navigation repeated in several places
- **Before:**
  - The Supervisor bar or rail has Board, Conversations, Model and More.
  - The `#general / #needs-you / #tasks / #sessions / #activity` chips duplicate Board's Projects, Sessions, Tasks and Activity modes.
  - `#tasks` also duplicates the Tasks tab.
  - Chat has its own Conversations, Model and More.
  - Settings is reachable from Today's gear, Chat's More menu and the Supervisor's More menu.
- **After:** each destination gets one home:
  - Conversations: the sidebar on the unfolded Duo, the toolbar elsewhere.
  - Channels: the chips only. Drop Board's duplicate modes, or make Board the only switcher.
  - Tasks: its tab.
  - Model: inside the conversation's More menu.
  - Settings: the Today gear, plus More.
  - Keep every destination reachable at every size (SwiftUI Pro: features must not disappear when folded).

### P2-2. Several entry points for the same action
- **Before:**
  - Voice: a full-width "Talk with Supervisor" bar plus the composer's mic (`img/duo-cover-supervisor-annotated.jpg` #5).
  - Agent replies: the thread sheet's "Reply to <workspace>…" field (`img/duo-cover-thread-reply-annotated.jpg`), the card's *Reply in chat*, and quick-reply pills.
- **After:**
  - Voice: one place to start it, the composer mic. Tap dictates into the draft (review before Send); long-press starts **live voice**, which sends spoken turns directly. Live voice must look and be labeled as a different mode, because it has no review step.
  - Agent replies: keep **Reply to agent** (sent straight to the agent) visibly different from **Ask Supervisor**:
    - The thread sheet's field gets the same pill style as Chat.
    - It gets an "To agent" label and a 44pt send control.

### P2-3. Passive status looks like controls; real actions look passive
- **Before:**
  - "1 watched" is a button-shaped pill that is only status (#7).
  - "daemon.example.com · Synced" repeats at the top of Today, Inbox and Tasks.
  - The Supervisor `topBannerStack` (SupervisorView.swift:850) can stack up to five rows above the chat: walkthrough, warning, autonomy, catch-up and status note. They mix actions (Retry, Back, Pause, Next) with plain information, all in the same small type.
  - The status-note close button is an unlabeled `xmark`.
- **After:**
  - Status as plain text with an icon. Show the connection line only when it isn't synced, plus always in Settings.
  - Fold the banners into one actionable row with the most urgent first (for example, can't reach → Retry). Put the rest behind "Details".
  - Every icon button gets a text label (HIG 5.1, SwiftUI Pro accessibility).

### P2-4. Touch targets and type
- **Before:**
  - The card's X is 24pt.
  - Hide is caption2 with 4pt padding.
  - Secondary "Dismiss" is 36pt tall.
  - Walkthrough Back, Pause and Next are caption text.
  - The thread reply's send button is about 22pt.
  - caption2 is used for card metadata and focus icons.
  - All of these fall under HIG's 44pt minimum; caption2 is the "avoid" size.
- **After:** every control at least 44×44; caption is the smallest text style; built-in text styles only.

### P2-5. Space on the Duo cover screen
- **Before** (`img/duo-cover-supervisor-annotated.jpg` #8): the decision card keeps a third of its height empty on a short, wide screen, and the chips, card, voice bar and composer leave little room for the conversation.
- **After:**
  - The card fits its content, with at most three lines of body before "More".
  - The voice bar goes away (see P2-2).
  - The deck collapses to one line while the composer has focus. It already does on iPhone; check it on the cover screen.

### P3
- The thread sheet shows two titles: "Conversation" and "Demo workspace". Use the workspace as the title.
- Today's "3 waiting on you" row looks passive but opens the Inbox. Give it a disclosure chevron or button styling.
- Chat's Copy and Share icons under replies work but have no text. Add `Label` text with an icon-only style for VoiceOver.

## 3. Action parity map (every safeguard stays)

"Same" means the action has to be reachable with the same safeguard in every column.

| Action | Where today | Safeguard | iPhone | Duo cover | Duo unfolded (proposed) |
|---|---|---|---|---|---|
| Answer a decision with its listed option (yes/no…) | Card pills, thread sheet | Option buttons send the exact option; `act`/`decide` | ✓ | ✓ | Same, in the detail pane |
| Free-text reply to the agent | Thread sheet "Reply to <workspace>" | Direct to the agent, explicit field | ✓ | ✓ | Same field, labeled "To agent" |
| Reply in chat (Supervisor composer focused on a card) | Card "Reply in chat" | **Today: implicit auto-focus (P1-1)**. Proposed: explicit chip | ✓ | ✓ | Same chip |
| Ask Supervisor | Supervisor composer | Tool confirmation is conditional for the owner: `ownerInvoke` can run `fleet_send_message` / `reply_to_coding_agent` without a prompt when the message reads as assent | ✓ | ✓ | Same, but the composer mode must be explicit (P1-1) |
| Later (defer) | Grey "Dismiss" text (mislabeled) | None needed; reversible | ✓ | ✓ | Labeled "Later", in More |
| Dismiss | Card X (no confirmation) | **Today: none (P1-2)**. Proposed: confirmation | ✓ | ✓ | In More, with confirmation |
| Archive session | Card action | `pendingArchiveConfirmation` dialog | ✓ | ✓ | Unchanged |
| Hide cards (local collapse) | "Hide ▾" | Local only | ✓ | ✓ | In More |
| Merge green PRs (batch) | #needs-you stage | Existing `batchAct` gating | ✓ | ✓ | Unchanged |
| Approve a pending action | Inbox, Chat card → Review → ApprovalDetailView | Approve/Deny only in the detail view, with result handling and computer-unavailable copy | ✓ | ✓ | Unchanged; card stays Review-only |
| Hide an approval card in Chat | Chat card "Hide" | Local; the approval stays in the Inbox | ✓ | ✓ | Unchanged |
| Dictation | Composer mic | Fills the editable draft; nothing is sent until Send | ✓ | ✓ | Same |
| Live voice conversation | "Talk with Supervisor" bar | **Different behavior:** `startVoice()` starts `VoiceSession.handsFree(true)`; spoken turns are sent and saved without an editable draft or Send | ✓ | ✓ | Keep as its own clearly labeled mode (e.g. long-press on the mic). Do not merge it into dictation in a way that implies review before sending |
| Open the thread or conversation | Card ›, thread sheet | Read-only | ✓ | ✓ | Detail pane instead of a sheet |
| Board and channels | Board button, chips | Read-only | ✓ | ✓ (chips clipped) | Sidebar |
| Settings, model | Today gear, More menus | Revoke has its own confirmation | ✓ | ✓ | Same |

## 4. Acceptance checklist (Duo as a full target)

Each check runs on iPhone, the Duo cover and the Duo unfolded (book and tabletop postures), in light and dark, at default and AX3 text sizes:
1. Every screen has no content under the status column or the fold, and no clipped chips.
2. The composer mode is always visible. Reply to a decision only happens after an explicit tap. Clearing it returns to "Ask Supervisor".
3. Dismiss always asks for confirmation; Later never does; Archive keeps its dialog.
4. Keyboard on cover and unfolded: nothing freezes (the #283 regression test), the deck collapses, and Send stays above the keyboard.
5. VoiceOver can reach every control in the card, composer and rail, all with meaningful labels and in a sensible order.
6. Every action in §3 is reachable on every surface.

Still not run: half-folded postures, a VoiceOver pass, and Today, Inbox and Settings on the physical device.
