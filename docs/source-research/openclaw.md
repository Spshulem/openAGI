# OpenClaw Source Research

Source: https://github.com/openclaw/openclaw

## Files Reviewed

- `docs/concepts/memory.md`
- `docs/cli/cron.md`
- `docs/cli/mcp.md`
- `docs/gateway/authentication.md`

## Useful Patterns

OpenClaw treats memory as explicit local artifacts rather than hidden state. Long-term memory is durable markdown, recent notes are date-scoped, and search sits on top of those artifacts.

Key ideas to adopt:

- Keep durable memory inspectable by humans.
- Separate daily/current notes from long-term memory.
- Add a promotion/dreaming pass before long-term writes.
- Pair semantic search with keyword search so exact IDs still work.
- Make memory flush explicit before context compaction.

OpenClaw cron is more production-shaped than PicoClaw. It includes session targeting, delivery modes, failure destinations, skipped-run handling, manual runs, model selection, and run logs.

Key ideas to adopt later:

- Distinguish main, isolated, current, and pinned sessions.
- Keep job definitions separate from pending runtime state.
- Track skipped runs separately from execution errors.
- Store run logs as JSONL.
- Suppress stale acknowledgement-only outputs.

OpenClaw MCP has two roles: serving OpenClaw-backed conversations to MCP clients and storing outbound MCP server definitions for runtimes to consume.

Key ideas to adopt:

- Keep MCP server registry separate from live execution.
- Do not invent routes; only expose routes the gateway already knows.
- Use token/password files instead of inline secrets.
- Redact sensitive URL/header values.
- Filter unsafe stdio startup environment variables.

## Local Adoption

Implemented now:

- MCP registry remains config-only and does not execute processes.
- Hosted API exposes runtime state, memory, agents, cron, and MCP registry.
- Durable runtime uses explicit data directory.

Deferred:

- Gateway auth.
- WebSocket event streams.
- MCP stdio/SSE execution.
- Hybrid vector/keyword memory search.
- Cron run logs and isolated sessions.
