---
id: unblock-snag
cooldown_min: 15
max_attempts: 2
ask: "{label} stuck on {snag}. Unblock?"
---
You stopped on a snag ({snag}). Diagnose the exact root cause and unblock the work using safe, documented paths in this workspace:
- Inspect the failing command, test log, git worktree state, or CI check directly.
- If a path, lock, port, missing dependency, or read-only directory blocked you, check existing workspace helpers, alternate worktrees, or non-interactive flags instead of stopping.
- Never bypass security, auth, or permission boundaries. If a genuine human-only step (login, 2FA, secret, or production approval) blocks every path, reply with `Blocked on: <exact minimal owner step>` in one line; otherwise fix the snag and continue to completion.
