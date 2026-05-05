# PicoClaw Source Research

Source: https://github.com/sipeed/picoclaw

## Files Reviewed

- `pkg/memory/store.go`
- `pkg/memory/jsonl.go`
- `pkg/cron/service.go`
- `pkg/mcp/manager.go`

## Useful Patterns

PicoClaw's memory store is small and practical. It defines a storage interface with atomic operations, then backs sessions with append-only JSONL files plus a separate metadata JSON file.

Key ideas to adopt:

- Append records as JSONL for crash-friendly writes.
- Maintain a separate compact current-state metadata/snapshot file.
- Treat truncation as logical first, physical later.
- Keep storage operations atomic at the method boundary.
- Use safe filename normalization for user/session keys.

The cron service stores job definitions in a JSON file, keeps runtime state with each job, computes the next wake time, and executes jobs outside the scheduler lock.

Key ideas to adopt:

- Persist job definitions and next-run state.
- Recompute next run on startup.
- Mark due jobs before execution so they do not double-run.
- Save status and error information after execution.
- Support one-shot and recurring schedules.

The MCP manager separates saved server configuration from live connections and supports stdio, SSE, and HTTP-style transports.

Key ideas to adopt later:

- Treat MCP configuration as a registry first.
- Resolve env files relative to workspace.
- Load servers concurrently but tolerate partial failure.
- Track lifecycle and close all live sessions cleanly.
- Reconnect on missing/lost sessions.

## Local Adoption

Implemented now:

- `FileBackedMemorySystem`: JSONL audit log plus atomic current-state snapshot.
- `FileBackedCronScheduler`: atomic JSON job store.

Deferred:

- Full MCP process execution.
- Cron retry/backoff history.
- Physical log compaction.
- Per-session transcript stores.
