# TinyAGI Source Research

Source: https://github.com/TinyAGI/tinyagi

## Files Reviewed

- `packages/core/src/agent.ts`
- `packages/core/src/memory.ts`
- `.agents/skills/schedule/SKILL.md`
- `.agents/skills/memory/SKILL.md`

## Useful Patterns

TinyAGI models agents as workspace-backed teammates. Each agent has a directory, custom `AGENTS.md`, skills, heartbeat, and hierarchical memory.

Key ideas to adopt:

- A propagated specialist should have a workspace, not just an in-memory record.
- Specialist prompts should include team membership and role context.
- Skills/tools should be synced into each specialist workspace.
- Memory should be summarized as an index first, with detailed files loaded on demand.

TinyAGI schedules are persisted in a JSON file and run in-process. When a schedule fires, it enqueues a routed agent message.

Key ideas to adopt later:

- Treat scheduled work as a message to an agent.
- Support both recurring cron expressions and one-time `runAt` jobs.
- Expose schedule management through REST and UI.
- Auto-disable one-time schedules after firing.

TinyAGI memory is hierarchical markdown with YAML frontmatter.

Key ideas to adopt later:

- Store specialist memory under category folders.
- Require `name` and `summary` metadata.
- Load a compact memory index into agent context.
- Update existing memories instead of creating duplicates.

## Local Adoption

Implemented now:

- Specialists have bounded scope, parent goal, success metric, allowed tools, and activation counts.
- Durable runtime can persist the decisions that create specialists through memory and outputs.

Deferred:

- Per-specialist workspace folders.
- Per-specialist hierarchical markdown memory.
- Queue-backed scheduled messages.
- TinyOffice-style UI.
