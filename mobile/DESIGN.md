# OpenAGI mobile — design system

Both apps are built natively (SwiftUI, Compose) against this one document. They
share no code, so every agreement here is maintained by hand. When the two
platforms must differ, it is because the platform differs, never because two
people made two choices.

## What this thing is

OpenAGI is a daemon running on hardware you own. It is not a cloud service with
an app in front of it. The phone is a **remote control for a machine that is
already working** — it reaches that machine over your tailnet or your LAN, and
when it cannot, the app says so plainly instead of spinning.

That shapes everything below. The three questions the interface answers, in
order of how often they are asked:

1. What is on today, and can I clear it from here?
2. Is the daemon alive right now?
3. What is waiting on my approval?

## The one idea

**The machine is a place you are connected to.** Your daemon lives at a real
address — `mac.tail1234.ts.net:43210` — and that address is personal content,
not configuration to hide behind a gear icon. Every screen carries a quiet
**connection line** directly under its title: the host, when it last synced, and
a small dot that is filled when the data is fresh and hollow when it is stale.

This is the app's identity. It is also the honest answer to question 2, always
visible, never a modal.

## Colour

Six values per mode. Nothing else.

| Token | Light | Dark | Used for |
|---|---|---|---|
| `canvas` | `#F1F3F2` | `#0E1211` | Screen background |
| `surface` | `#FFFFFF` | `#171C1A` | Rows, cards, fields |
| `ink` | `#13171A` | `#ECEFED` | Primary text |
| `muted` | `#5C6763` | `#93A09A` | Secondary text, hairlines' labels |
| `live` | `#0E6F4E` | `#4BC48D` | Connected, complete, confirm |
| `alert` | `#A32C22` | `#F08A7E` | Overdue, deny, unreachable |

`edge` hairlines: `#E2E6E4` light, `#262D2A` dark.

The canvas carries a faint green cast so `live` sits in the same family rather
than reading as a bolted-on accent. `live` is deliberately a deep forest green,
not a signal green on black — this is an instrument you read in daylight, not a
terminal.

Both platforms must support light and dark. Android additionally accepts Material
You dynamic colour **only** for container tints; `live` and `alert` keep these
exact values, because a task being overdue must not change hue with the wallpaper.

## Type

System faces, used deliberately: **SF Pro** on iOS, **Roboto** on Android. No
custom font files — a downloaded webfont on a native app is a tell of a
cross-platform shell, which this is not.

**Monospace is reserved for machine identifiers**: the host address, the 6-digit
pairing code, node ids. SF Mono / Roboto Mono. This is the structural device that
encodes meaning — if it is monospace, a machine chose it. Never use mono for
body copy, labels, or numbers that are merely numeric (a task count is prose).

| Role | Size / weight | Notes |
|---|---|---|
| Screen title | 34 semibold | One per screen, left aligned |
| Section | 20 semibold | |
| Body | 17 regular | Task titles |
| Secondary | 15 regular | `muted` |
| Caption | 13 regular | `muted`, the connection line |
| Data (mono) | 13 regular | Host, code, ids |
| Code entry (mono) | 28 medium | Pairing code field only, tracked +2 |

Line length stays under 70 characters for any paragraph. Sentence case
everywhere. No all-caps labels, no eyebrow text above headings.

## Layout

8pt spacing grid. Screen gutter 20. Rows are 60 tall minimum so a thumb can hit
them; the completion control is a 44×44 target inside that.

Rows sit on `surface` in grouped blocks with 12 corner radius and hairline
separators between — not as individually floating cards with shadows. One radius
value for row groups (12), one for the widget's own container (platform
default). No drop shadows anywhere; separation comes from the `canvas`/`surface`
contrast and hairlines.

```
┌─────────────────────────────────┐
│                                 │
│  Today                          │  34 semibold, ink
│  ● mac.tail1234.ts.net · 2m     │  13 mono host, 13 caption muted, live dot
│                                 │
│  ┌───────────────────────────┐  │
│  │ Ship the widget        ( )│  │  17 body, 44pt tap target
│  ├───────────────────────────┤  │  hairline
│  │ Renew the domain       ( )│  │
│  │ Overdue                   │  │  13 caption, alert
│  └───────────────────────────┘  │
│                                 │
│  2 left today, 1 this week      │  15 muted
│                                 │
└─────────────────────────────────┘
```

Content is left aligned throughout. Nothing is centred except the empty state
and the pairing code field.

## Motion

**One orchestrated moment: completing a task.** The control fills with `live`,
a checkmark draws, the row's text dims, and the row collapses out of the list
over ~260ms. That is the only animation the app performs that a person did not
directly cause, and it exists because it confirms an action that otherwise has
no feedback until the next sync.

Everything else: no entrance animations, no fade-and-slide on appear, no
shimmer, no pulsing dot. The connection dot changes state without animating.

Respect reduced-motion: the row still disappears, it just does not animate.

## Copy

Plain, active, sentence case. The interface speaks about the daemon in the third
person and never apologises.

- Empty today: **"Nothing left today."** with, below, "New tasks appear here when OpenAGI or you add them."
- Unreachable: **"Can't reach OpenAGI."** then the real reason and the real fix, e.g. "Nothing is listening at mac.tail1234.ts.net:43210. Is the daemon running?"
- Refused host: **"That address can't be reached from a phone."** then "Plain http works only on a tailnet or your home network. Loopback never works — the phone isn't the machine."
- Wrong code: **"That code didn't work."** then "Codes last 30 minutes and work once. Run `openagi pair-phone` for a new one."
- Stale widget: **"Last synced 3h ago"** — state the fact, do not say "offline" when you do not know that.
- Buttons name the action and keep the name through the flow: `Pair` → `Paired`, `Approve` → `Approved`, `Send` → the message appears.

Never: "Oops", "Something went wrong", "Please try again later", an error that
does not say what to do next.

## Components

**Connection line.** Dot (6pt, `live` filled when synced under 60 min, `muted`
hollow when older, `alert` filled when the last refresh failed) + host in mono +
relative time in caption. Appears under every screen title.

**Task row.** Title in body. Second line only when there is something to say:
`Overdue` in `alert`, or the bucket when not today. Completion control on the
trailing edge: a 22pt hollow circle in `muted`, filling `live` on tap.

**Row group.** `surface`, radius 12, hairline separators, no shadow.

**Primary button.** Filled `live`, white text, radius 10, 50 tall, full width.
**Destructive.** Text only, `alert`. Never a filled red button — revoke is rare
and should not look like the primary path.

**Empty state.** Centred, a single line of `ink` plus a line of `muted`. No
illustration, no icon larger than 28pt.

## Chat

A conversation, not a transcript. The first build of this screen put a "You" /
"OpenAGI" caption above each message and left every line full-width and left
aligned, which reads as a log file. **Alignment carries the speaker** — that is
what makes a chat feel like a chat on both platforms, and it means no speaker
labels at all.

- **You:** right aligned, max 78% width, `live` at 12% opacity as the bubble
  fill, `ink` text, radius 18 with the bottom-trailing corner at 4.
- **OpenAGI:** left aligned, max 85% width, `surface` fill, `ink` text, radius
  18 with the bottom-leading corner at 4.
- Consecutive messages from the same speaker tighten to 2pt apart; a change of
  speaker opens to 12. No timestamp unless more than 15 minutes passed, and then
  it is a centred `caption` in `muted` between the two groups.
- **Assistant replies render Markdown** — bold, inline code, fenced code blocks,
  bullet and numbered lists, links. A reply full of raw `**asterisks**` is the
  clearest possible sign the app does not understand its own content. Fenced
  code uses the mono face on a subtly darker fill, scrolls horizontally rather
  than wrapping, and is long-press copyable.
- **Streaming is the point.** Before the first token, show a three-dot resting
  indicator inside an assistant bubble — not a full-screen spinner. As `delta`
  frames arrive, append into that same bubble so it grows. The list stays pinned
  to the bottom while the user has not scrolled away; if they have scrolled up,
  do not yank them back — show a "jump to latest" affordance instead.
- The composer sits above the keyboard, never behind it, and keeps the safe area
  on a home-indicator device. It grows to 5 lines then scrolls. Send is disabled
  and `muted` until there is non-whitespace text.
- A failed send stays in place in `alert` with a "Try again" directly under it.
  It is never silently dropped and never a modal.
- Long-press any message to copy it.

The connection line on this screen reads `live` while the event stream is
attached and `reconnecting` when it is not — the one screen where that
distinction is worth the words.

## Screens must not be mostly empty

Several screens shipped as a title, a short list, and a large blank rectangle.
A screen with nothing below the fold should either earn the space or not take
it. Where a surface has little to show, it carries the next most useful thing
rather than whitespace:

- **Today** — under the task list: the day's shape in one sentence, then, when
  something is waiting, a single row linking to Inbox ("2 waiting on you"). When
  there are no tasks at all, the empty state is the whole screen, centred.
- **Inbox** — approvals and clarifications are two sections of one list. **If
  one of the two fails to load, the other still renders**, and the failure is a
  single inline row in that section, not an error that replaces the screen. A
  badge promising two items above a blank screen is worse than either alone.
- **Tasks** — bucket sections are always present in order; an empty bucket shows
  a one-line `muted` "Nothing here" rather than vanishing, so the structure of
  the week is legible even when parts of it are empty.

## Widget

The widget is the reason this project exists. It is not a shrunken app screen.

- **Small:** the count as the hero ("3 today"), then the single most urgent task.
- **Medium:** up to 3 tasks with working tap-to-complete targets.
- Header on both: "Today" with the connection dot. When the snapshot is older
  than 60 minutes, the header reads "Last synced 3h ago" in `muted` and the
  rows dim — the widget never renders stale data as though it were current.
- Unpaired: one line, "Open OpenAGI to pair this phone."

The widget reads the snapshot the app wrote. It never fetches. A tap completes
optimistically and the app replays it on its next refresh.

## The quality floor

Both apps must: support light and dark, scale with the system text size up to
at least XXL without clipping, keep 4.5:1 contrast for body text, expose real
accessibility labels on the completion control ("Complete Ship the widget"),
respect reduced motion, and never show a spinner without a way out.
