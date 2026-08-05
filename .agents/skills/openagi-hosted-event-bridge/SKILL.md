---
name: openagi-hosted-event-bridge
description: Use when changing openAGI hosted-interface event bus wiring, SSE broadcast event names, outreach feed/digest routes, skill-candidate notifications, or subsystem bindEvents integration.
---

# openAGI Hosted Event Bridge

## When to use

Use this skill when work touches `src/hosted-interface.js` event wiring, `src/outreach-mapper.js`, `src/outreach-digest.js`, `src/outreach-store.js`, `src/suggestion-feed.js`, `src/skill-replay.js`, `src/pending-actions.js`, `src/computer-use-log.js`, `mac/Sources/OpenAGI/AppState.swift`, or tests named `test/outreach-endpoints.test.js`.

Use it for failures containing `404 !== 200` on `/outreach/feed` or `/outreach/digest`, missing `skill-candidate` or `miner-result` delivery, a subsystem reading `this.events` in its constructor, or questions about whether miner candidates are dashboard-only.

## Procedure

1. Treat `createHostedInterface()` as the owner of the live event bus.
   - `src/hosted-interface.js` creates `const events = new EventEmitter()` inside `createHostedInterface()`.
   - It forwards selected bus events to SSE through `events.on("event-name", (data) => broadcast("event-name", data))`.
   - It exposes the bus to the runtime with `Object.defineProperty(runtime, "events", { value: events, enumerable: false })`.

2. Use late-bound event hooks for runtime subsystems.
   - Subsystems that need the hosted event bus implement `bindEvents(events)` and store the reference there.
   - `src/pending-actions.js` and `src/computer-use-log.js` use this pattern.
   - `src/hosted-interface.js` calls known binders near the top-level event wiring block: `runtime.skillReplay.bindEvents(events)`, `runtime.pendingActions.bindEvents(events)`, and `runtime.computerUseLog.bindEvents(events)`.
   - Do not attach a mapper or listener from a constructor through `this.events`; the hosted bus does not exist there.

3. Add new SSE surfaces in both halves of the bridge.
   - Add an `events.on("name", ...)` listener in the hosted-interface event block.
   - Make the producer emit on `runtime.events?.emit?.("name", payload)` or on a subsystem `events` reference set by `bindEvents`.
   - For miner skills, the per-candidate event is `skill-candidate`; `miner-result` is only the summary event from manual mining.

4. Add hosted HTTP routes inside the existing route handler style.
   - Use `if (method === "GET" && pathname === "/...") { ... return sendJson(res, 200, obj); }`.
   - Use `url.searchParams` for query parameters.
   - Do not add route-local auth to normal hosted routes; auth is enforced globally before route handling.
   - For `/outreach/feed?since=N`, return items from `runtime.outreach.since(cursor)` and a cursor based on `runtime.outreach.nextSeq - 1`.
   - For `/outreach/digest`, call the digest composer against `runtime.outreach` and `runtime.outreachConfig` and return an object containing `digest`.

5. Keep skill candidates out of the transient-only trap.
   - `src/session-miner.js` and `src/pattern-miner.js` emit `skill-candidate` when they persist candidates into `skills-suggested/`.
   - `src/hosted-interface.js` must broadcast `skill-candidate` over SSE.
   - The Mac app consumes `skill-candidate` and shows the native notification that opens the Skills tab.
   - If the task asks for durable outreach or digest behavior, also map the candidate into `src/outreach-mapper.js`; SSE alone is lost when no Mac/dashboard client is connected.

## Failure signatures

- `Expected values to be strictly equal: 404 !== 200` in `test/outreach-endpoints.test.js`: the `/outreach/feed` or `/outreach/digest` route is absent or inserted after a return path that prevents it from matching.
- `this.events is undefined` or a mapper cannot attach during runtime construction: move the event attachment to a `bindEvents(events)` hook or to hosted-interface after `const events = new EventEmitter()`.
- A claim says miner candidates are dashboard-only while `skill-candidate` exists: check `src/session-miner.js`, `src/pattern-miner.js`, `src/hosted-interface.js`, and `mac/Sources/OpenAGI/AppState.swift`; the missing part is durable outreach only if `src/outreach-mapper.js` lacks `skill-candidate`.
- `miner-result` is wired but no user notification appears for individual skills: wire or test `skill-candidate`; `miner-result` is the aggregate mining summary.

## Verification

- `node --test test/outreach-endpoints.test.js` passes after `/outreach/feed`, `/outreach/digest`, or outreach action route changes.
- A focused grep shows every new event has both producer and hosted-interface broadcast wiring: `rg "skill-candidate|miner-result|outreach" src/hosted-interface.js src/*.js mac/Sources/OpenAGI/AppState.swift`.
- Subsystems that emit after hosted startup have `bindEvents(events)` coverage and do not depend on constructor-time `this.events`.
- Skill candidate notification work proves both transient delivery (`skill-candidate` SSE/Mac notification) and durable delivery when required (`outreach-mapper.js` plus digest/feed coverage).
