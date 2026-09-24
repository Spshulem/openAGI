package sh.openagi.mobile.util

import sh.openagi.mobile.transport.DaemonException

// DESIGN.md's copy rules, centralized: "errors say what to do", never
// "Something went wrong". Pure — no Context, no resources — so every screen
// gets the same wording and it's trivial to pin with tests, rather than
// each screen inventing its own phrasing (or worse, rendering
// DaemonException's own message, which is written for a developer log line,
// not for someone deciding what to do next).
object ErrorCopy {
    data class Message(val headline: String, val detail: String)

    // The pairing screen's code-exchange call.
    fun forPairing(error: DaemonException, host: String): Message = when (error) {
        is DaemonException.UnreachableHost -> Message(
            "That address can't be reached from a phone.",
            "Plain http works only on a tailnet or your home network. Loopback never works — the phone isn't the machine.",
        )
        is DaemonException.Unauthorized -> Message(
            "That code didn't work.",
            "Codes last 30 minutes and work once. Run openagi pair-phone for a new one.",
        )
        is DaemonException.Conflict -> Message(
            "That code was already used.",
            "Run openagi pair-phone for a new one.",
        )
        is DaemonException.Transport -> Message(
            "Can't reach OpenAGI.",
            "Nothing is listening at $host. Is the daemon running?",
        )
        is DaemonException.NotFound, is DaemonException.Malformed, is DaemonException.Server -> Message(
            "Pairing failed.",
            "Try again, or run openagi pair-phone for a new code.",
        )
    }

    // Every other screen, once already paired: fetching or mutating tasks,
    // approvals, clarifications, chat.
    fun forDaemon(error: DaemonException, host: String): Message = when (error) {
        is DaemonException.Unauthorized -> Message(
            "Needs re-pairing.",
            "Revoke and pair again in Settings.",
        )
        is DaemonException.Transport -> Message(
            "Can't reach OpenAGI.",
            "Nothing is listening at $host. Is the daemon running?",
        )
        is DaemonException.UnreachableHost -> Message(
            "That address can't be reached from a phone.",
            "Plain http works only on a tailnet or your home network. Loopback never works — the phone isn't the machine.",
        )
        is DaemonException.NotFound -> Message(
            "That's gone.",
            "It may have already been removed from another device.",
        )
        is DaemonException.Conflict -> Message(
            "That's already been handled.",
            "Someone or something else got there first — refresh to see the current state.",
        )
        is DaemonException.Malformed -> Message(
            "Can't read OpenAGI's reply.",
            "Try again in a moment.",
        )
        is DaemonException.Server -> Message(
            "OpenAGI had a problem.",
            "Try again in a moment.",
        )
    }
}
