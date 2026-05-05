# External Source Map

This repo currently uses external projects as architectural references, not vendored code.

| Project | Repo | License | Useful Ideas | Local Decision |
| --- | --- | --- | --- | --- |
| OpenClaw | https://github.com/openclaw/openclaw | MIT | Gateway control plane, sessions, cron, webhooks, MCP, memory plugins, multi-channel integrations, hosted UI | Study and selectively reimplement compatible primitives. Do not import the large codebase yet. |
| PicoClaw | https://github.com/sipeed/picoclaw | MIT | Small Go runtime, CLI cron, MCP manager, JSONL memory, gateway, lightweight deployability | Use as a reference for a compact core and simple operational surface. |
| TinyAGI, formerly TinyClaw lineage | https://github.com/TinyAGI/tinyagi | MIT | Agent teams, schedules, memory, skills, hosted office UI | Use as reference for propagation and team-oriented agents. |
| TinyClaw by warengonzaga | https://github.com/warengonzaga/tinyclaw | GPL-3.0 | Adaptive memory, plugin architecture, security framing | Avoid copying code unless the repo intentionally adopts GPL obligations. |

## Pull Strategy

1. Keep this repo clean-room until the ABI domain model is stable.
2. If we need OpenClaw compatibility, add adapters at the edges: config import/export, MCP tool registry, cron import, and memory migration.
3. If we need PicoClaw compatibility, add a JSONL memory importer and cron CLI importer first.
4. If we need TinyAGI compatibility, map specialist agents to TinyAGI-style team workspaces instead of copying internals.

## Security Note

Agent frameworks that execute tools, plugins, MCP servers, or shell commands need explicit trust boundaries. This scaffold registers MCP servers and tools, but does not execute external processes yet.
