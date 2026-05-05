# Adoption Plan

## Principle

OpenAGI keeps the ABI flywheel as the center. External projects contribute infrastructure patterns around it.

## Implemented In This Pass

1. Add a durable memory store using PicoClaw-style append events and atomic snapshots.
2. Add a durable cron store using PicoClaw/TinyAGI-style JSON job persistence.
3. Add `createDurableRuntime({ dataDir })` so production-like runs can persist state.

## Next Pulls

1. MCP execution boundary from PicoClaw/OpenClaw:
   - config validation;
   - stdio/SSE/HTTP transport shape;
   - env safety filter;
   - live session lifecycle.

2. Specialist workspaces from TinyAGI:
   - `agents/<id>/AGENTS.md`;
   - `agents/<id>/memory/`;
   - skill/tool manifest;
   - specialist prompt builder.

3. OpenClaw-style hosted gateway:
   - auth token file;
   - WebSocket events;
   - run logs;
   - route-aware channels.

4. Memory search:
   - keyword search first;
   - embeddings/vector search behind a provider interface;
   - promotion/dreaming pass for long-term Lava memory.
