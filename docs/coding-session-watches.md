# Codex and Claude session watches

## First slice and scope

Opt-in monitoring of up to 20 exact sessions on the configured coding node. Uses the existing supervisor discovery loop (default 30 seconds), not cron jobs, an extra agent, or paid model calls. Reads at most four recent transcript edges per refresh, only after a watched status/activity change. G2 checks its inbox every 60 seconds while foregrounded; this is not instantaneous push delivery.

Signals: waiting, stuck, failed, interrupted, and a newly idle session/new idle activity. An idle state or provider response does **not** establish that a user's task, tests, deployment, or release succeeded. Missing sessions and unavailable nodes are not reported as completed. No timer guesses that a long-running session is stuck; that requires a provider/discovery signal.

Output is a bounded, explicitly untrusted assistant excerpt plus a status-specific next-step prompt, not an AI-generated analysis. No automatic reply, retry, process manipulation, provider permission approval, or tool execution. Rich semantic summaries can be a later separately budgeted feature.

## Use

1. On main, open **Coding Agents**. Select **Watch session** and accept the preview-sharing explanation. Existing activity is baselined without flooding old notifications.
2. Or ask OpenAGI to watch an exact session. `list_coding_agents` resolves the target; `watch_coding_agent` queues approval before enabling/disabling. `list_coding_watches` lists selected watches. Replies continue through the existing separately approved `reply_to_coding_agent` path.
3. On G2, enable the proactive inbox and **Discoveries**. Existing quiet hours, foreground safety, snooze, dismiss and hourly limits apply. Transcript-memory consent is unrelated and not required.
4. On the phone/main inbox, **Review on main** opens the exact session under Coding Agents. Inspect recent output and request approval for a reply; if a provider has no safe reply route, use its owning app.
5. **Stop watching** prevents new reads and removes that watch's alerts from the G2 feed. Saved previews remain in main outreach history under its existing retention policy; this is disclosed before enabling. Missing sessions remain removable from the watch list.

## Safety and persistence

Watches use the existing private (0600) main supervisor state, keyed by coding node, provider and full session ID. Restart preserves baselines; unchanged state does not repeatedly notify. Changing the coding node pauses old watches rather than retargeting them. Switch back to manage watches on an old node. At most one open alert per watched session is retained; resumed work resolves the prior alert. Failed preview reads still surface the status without leaking provider errors. Stop/unwatch during a read suppresses delivery.

Normal hosted auth and Origin checks protect watch configuration. Voice changes require approval bound to the coding node. No changes to enrollment, node authentication, model defaults, or G2 package version.

## Validation and device acceptance

Automated fixtures cover opt-in baselines, restart deduplication, fast turns, missing sessions, node changes, unwatch/shutdown races, limits, preview failures, watch/reply approvals, HTTP auth/Origin, and G2 feed delivery/filtering.

After deploying the server and installing the previously prepared proactive G2 client: watch one disposable session in each provider, let each return a response and ask a question, verify one G2 alert per change (allow roughly 90 seconds plus provider discovery/read time), open the exact session on main, and approve a harmless follow-up. Repeat while quiet hours are active, while speaking/reading on G2, after restarting main, and after stopping the watch. Confirm no unsolicited reply was sent. This physical workflow has not been verified by automated tests.
