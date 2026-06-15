---
name: diagnose-agent-tool-errors
description: Troubleshoot opaque model/tool failures and runaway budget — and their usual root causes.
---

Diagnose in this order; report the root cause and the concrete fix.

1. Opaque "An error occurred while processing your request" (server_error) on tool-bearing calls, while plain replies (no tools) still work:
   - Almost always TOO MANY TOOLS. Each connected MCP server adds its tools to the array the model receives; one big server (100+ tools) can push the total past the provider's limit, which then rejects EVERY tool call — not just that server's.
   - Fix: a cap (`OPENAGI_MAX_MODEL_TOOLS`, default 128) advertises core tools + a budget of MCP tools and routes the rest through `run_mcp_tool`. Confirm the cap is in effect (look for the "[tools] N tools exceed model cap" log), lower it, or disconnect a giant server.

2. "Invalid 'tools[N].name' ... does not match pattern" error:
   - An MCP server NAME (or a tool name) contains a space or punctuation, producing an invalid `mcp_<server>_<tool>` function name. Rename the server to letters/digits/_/- only.

3. Budget draining unexpectedly fast, especially while idle:
   - Look for a MISPRICED model — a cheap nano/mini billed at flagship rates because a too-broad price-table prefix matched first. Verify the price table lists the exact model variant.
   - Look for an UNGATED periodic job calling a big model every cycle regardless of new work (the autopilot pulse should skip when its agent queue is empty; API-diff syncs should spend $0 when nothing's new).

To inspect: use the structural health snapshot, the budget + ledger, and `list_cron_jobs`.

User asked: {{input}}
