# G2 passive lifelog UX: 0.4.6

Follow-on user-requested UX scope:
[minimal listening, visible lifelog and actionable inbox](../g2-minimal-lifelog-ux-scope.md).
Those additions have a separate 0.4.7 candidate verification record; the
validation below applies only to 0.4.6.

Validation: 91 assembled-client tests across 15 files and TypeScript checking
passed. Regressions cover passive live/buffered speech, explicit wake opt-in,
manual-question resume, consent during startup, foreground exit, safe in-app
history rendering and existing pairing/send/navigation behavior. Physical
glasses behavior remains to be verified after installing the new bundle.

One client-only update, compatible with OpenAGI 0.0.23. No backend role, token,
budget, analysis, notification, or recording consent is enabled by deployment.

The old retention checkbox required an already-running microphone and reverted
to off when that prerequisite was missing. Start lifelog now opens listening
after explicit participant consent, then requests the existing expiring
retention grant. Withdrawal during startup invalidates the pending operation.

Quiet listening is the default, including migration from the old combined
always-listening setting. Wake responses are a separate explicit option;
overheard questions do not invoke the agent in quiet mode, whether speech is
Deepgram live or OpenAI buffered. Transcription is still required to save text
and consumes the configured speech provider; quiet means unobtrusive UI, not
offline transcription. The glasses show a packet-driven listening pulse and
retention state; phone transcript preview is collapsed by default.

Tap starts a manual question. Stop follows the existing auto-send/review setting.
Passive listening resumes after a completed request or discarded draft without
clearing the answer or obtaining a new retention grant. Double-tap on the idle
listening screen pauses. Back from inbox/answers preserves listening. Device or
document foreground exit stops speech and retention; return requires explicit
restart and fresh session consent. Background/all-day recording is not promised.

My lifelog reads only the paired G2's existing scoped history endpoint, with
search and pagination inside the phone app. No credential goes into a URL,
browser cookie, or external page. Owner-only model settings, editing, screen
context and cross-device access remain behind main authentication. Main inbox
links are marked advanced owner controls rather than the ordinary history path.

Acceptance: consent -> Start lifelog with microphone previously off; observe
saved transcript after the bounded upload interval; say the wake word and an
overheard question in quiet mode (no answer); tap/stop/review/send one explicit
question; verify listening resumes and answer remains; open My lifelog without
sign-in; withdraw consent during startup and recording; background and reopen
the app (no silent retention restart). Repeat with both speech providers.
