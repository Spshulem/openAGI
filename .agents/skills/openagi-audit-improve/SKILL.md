---
name: openagi-audit-improve
description: Audit a running OpenAGI installation and implement verified generic fixes when the user requests improvements or an audit-and-fix loop. Respect explicitly read-only audits.
---

# Audit through resolution

Inspect the running installation through its authenticated API without exposing credentials or raw personal content. Resolve the active data directory and runtime first; a repository checkout may differ from the installed app. Distinguish measured health from cached node reports, and test actual input readiness rather than an enabled flag.

When improvements are authorized, select an actionable defect supported by evidence and carry it through implementation, regression verification, and public-repository review. Prefer a broken user workflow over additional counters. A new warning fixes an observability gap; it does not resolve the condition it describes.

Reuse pending fixes and existing PRs before creating duplicates. Preserve stacked branch lineage and unrelated changes. Keep machine identities, credentials, personal content, and deployment-specific paths out of published code. Use isolated test data and the app's bundled Node for SQLite tests when the shell runtime lacks node:sqlite.

For authorized publication, push the tested fix and create or update its focused PR. Read current review threads, fix actionable comments, verify the change, and resolve each thread with concrete evidence. Check external status once unless monitoring was requested.

Track each finding as fixed and verified, implemented but not installed, or blocked with its exact missing prerequisite. Separate local tests, CI, merge, installation, and live/device proof. Do not claim end-to-end success from an enabled setting, heartbeat, or mock test. Do not automatically send messages, approve computer actions, change permissions, or remove user data as part of an audit.

End with the concrete fix, verification result, publication link when applicable, and any remaining blocker. Carry unresolved findings into the next authorized improvement run; do not repeatedly present unchanged findings as completed work.
