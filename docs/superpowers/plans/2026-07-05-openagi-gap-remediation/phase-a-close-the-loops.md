# Phase A: Close the Cheapest Loops (Week 1)

> **Read `00-INDEX.md` first** — its Global Constraints, decision gates, and execution protocol apply to every task below.
>
> **Drift rule:** Tasks in this plan share hot files (collision table in `00-INDEX.md`). If a Before-quote fails to match byte-for-byte and the difference is explained by an EARLIER task in this plan having edited that region (e.g. a new entry appended to `MAP` in `src/outreach-mapper.js`), apply the edit by intent — make the same change relative to the current code — and say so in the commit body. If the drift is NOT explained by an earlier plan task, STOP and report; the repo has moved since 2026-07-05.


---

<!-- verified:A1 status=fixed:3 -->
### Task A1.1: Map skill-candidate events into the durable outreach store (with open-item dedupe)
**Week:** 1 · **Size:** M · **Depends on:** none
**User story:** As Spencer (the openAGI owner), I want every mined skill candidate to become a durable outreach item instead of a fire-and-forget SSE notification, so that a candidate mined at 02:30 while no client is connected still reaches me in the next digest.
**Why (evidence):** Verified gap G3: `skill-candidate` events (emitted at src/pattern-miner.js:101 and src/session-miner.js:97) are absent from the `MAP` in src/outreach-mapper.js:6-39, so candidates never enter the outreach store; `digestTypes` in src/outreach-config.js:13 is `["draft", "suggestion"]` so even a stored skill item would be excluded from the digest. Live result: 74 candidates in ~/.openagi/skills-suggested, all pending, 0 accepted.
**Acceptance criteria:**
- `node --test test/outreach-mapper.test.js` passes with 3 new tests: a `skill-candidate` event creates an outreach item of `type: "skill"` with `sourceRef: { kind: "skill-candidate", id }`, `needsDecision: false`, `actions: ["accept", "dismiss"]`; re-emitting the same candidate id while an open (unseen/seen) item exists creates no second item; a resolved (dismissed) item does not block a new one.
- `node --test test/outreach-digest.test.js` passes with 1 new test: an unseen `type: "skill"` item rolls into the digest (title matches `/1 skill/`).
- `npm test` passes with 0 failures.
- No changes to abi-runtime.js are needed: `OutreachMapper.attach()` (src/outreach-mapper.js:48-60) iterates `Object.entries(MAP)`, so the new event is auto-subscribed wherever the mapper is already attached (src/abi-runtime.js:211-214 and bindOutreachEvents at :738-746).
**Files:**
- Modify: src/outreach-mapper.js:31 (MAP object — add entry after `"clarification-created"`)
- Modify: src/outreach-store.js:23 (`append` method — add `dedupeOpen` parameter)
- Modify: src/outreach-config.js:13 (`digestTypes` default)
- Test: test/outreach-mapper.test.js (extend)
- Test: test/outreach-digest.test.js (extend)
**Interfaces:**
- Consumes: `this.runtime?.events?.emit?.("skill-candidate", { source: "pattern-miner", id: candidate.id, name: proposal.name, description: proposal.description, occurrences: seq.count, judgeBypass })` (src/pattern-miner.js:101-108); `this.runtime?.events?.emit?.("skill-candidate", { source: "session-miner", id: candidate.id, name: proposal.name, description: proposal.description, occurrences: cluster.count })` (src/session-miner.js:97-103); `OutreachStore.append({ type, sourceRef, title, summary, needsDecision, actions })` (src/outreach-store.js:23); `OutreachStore.list({ status })` (src/outreach-store.js:52); `composeDigest(store, config, { now })` (src/outreach-digest.js:6).
- Produces: `MAP["skill-candidate"]` building `{ type: "skill", sourceRef: { kind: "skill-candidate", id: d.id }, title, summary, needsDecision: false, actions: ["accept", "dismiss"], dedupeOpen: true }`; extended `OutreachStore.append({ ..., dedupeOpen = false })` — when `dedupeOpen` is true and an item with the same `sourceRef.kind`+`sourceRef.id` exists with status `"unseen"` or `"seen"`, append returns that existing item and creates nothing; `OUTREACH_DEFAULTS.digestTypes === ["draft", "suggestion", "skill"]`. Task A1.2 relies on the `sourceRef` kind string `"skill-candidate"`; Task A1.3 relies on `type: "skill"` and on `"skill"` being in `digestTypes`.

1. [ ] Append the following three tests to the end of `test/outreach-mapper.test.js` (after the `attach is idempotent` test at line 64):
```js
test("skill-candidate maps to a durable skill outreach item", () => {
  const { events, store } = harness();
  events.emit("skill-candidate", {
    source: "pattern-miner",
    id: "sug_abc",
    name: "morning-triage",
    description: "Morning triage routine across Slack, Linear, Xcode",
    occurrences: 6,
    judgeBypass: false
  });
  const items = store.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "skill");
  assert.equal(items[0].needsDecision, false);
  assert.deepEqual(items[0].sourceRef, { kind: "skill-candidate", id: "sug_abc" });
  assert.deepEqual(items[0].actions, ["accept", "dismiss"]);
  assert.match(items[0].title, /morning-triage/);
  assert.match(items[0].summary, /Morning triage routine/);
});

test("re-emitting the same skill-candidate does not create a second open item", () => {
  const { events, store } = harness();
  const payload = { source: "session-miner", id: "ses_dup", name: "weekly-report", description: "Recurring weekly report request", occurrences: 3 };
  events.emit("skill-candidate", payload);
  events.emit("skill-candidate", payload);
  assert.equal(store.list().filter((i) => i.sourceRef?.id === "ses_dup").length, 1);
});

test("a resolved skill item does not block a new item for the same candidate", () => {
  const { events, store } = harness();
  const payload = { source: "pattern-miner", id: "sug_res", name: "standup-prep", description: "prep standup notes", occurrences: 4 };
  events.emit("skill-candidate", payload);
  const first = store.list()[0];
  store.resolve(first.id, { action: "dismiss", by: "user" }, { status: "dismissed" });
  events.emit("skill-candidate", payload);
  assert.equal(store.list().filter((i) => i.sourceRef?.id === "sug_res").length, 2);
});
```
2. [ ] Run `node --test test/outreach-mapper.test.js`. Expect 3 failures: `✖ skill-candidate maps to a durable skill outreach item` with `AssertionError [ERR_ASSERTION]` (`0 !== 1` from `assert.equal(items.length, 1)` — the event is currently unmapped so no item is created); the second dedupe test fails the same way (`0 !== 1`); the third test fails with `TypeError: Cannot read properties of undefined (reading 'id')` at `first.id` (store.list() is empty, so `store.list()[0]` is undefined). The 5 existing tests must still pass.
3. [ ] Edit `src/outreach-mapper.js` — add the `skill-candidate` entry to `MAP`. Before (quote exactly):
```js
  "clarification-created": (d) => ({
    type: "clarification",
    sourceRef: { kind: "clarification", id: d.id },
    title: d.question ?? "Quick question",
    summary: d.context ?? "",
    needsDecision: true,
    actions: ["yes", "no", "in_progress", "dropped"]
  })
};
```
After:
```js
  "clarification-created": (d) => ({
    type: "clarification",
    sourceRef: { kind: "clarification", id: d.id },
    title: d.question ?? "Quick question",
    summary: d.context ?? "",
    needsDecision: true,
    actions: ["yes", "no", "in_progress", "dropped"]
  }),
  // Miner-proposed skill candidates (pattern-miner.js / session-miner.js both
  // emit "skill-candidate" with { source, id, name, description, occurrences }).
  // Durable counterpart to the transient SSE notification: lands in the digest
  // via digestTypes and survives the miners running at 02:30/03:30 with no
  // client connected. dedupeOpen guards against a miner re-emitting the same
  // candidate id while an earlier item is still open.
  "skill-candidate": (d) => ({
    type: "skill",
    sourceRef: { kind: "skill-candidate", id: d.id },
    title: d.name ?? "New skill candidate",
    summary: d.description ? d.description : (d.occurrences ? `Observed ${d.occurrences} times` : ""),
    needsDecision: false,
    actions: ["accept", "dismiss"],
    dedupeOpen: true
  })
};
```
4. [ ] Edit `src/outreach-store.js` — teach `append` the `dedupeOpen` flag. Replace the whole method. Before (quote exactly):
```js
  append({ type, sourceRef = null, title, summary = "", needsDecision = false, actions = [] }) {
    const item = {
```
After:
```js
  append({ type, sourceRef = null, title, summary = "", needsDecision = false, actions = [], dedupeOpen = false }) {
    if (dedupeOpen && sourceRef?.id) {
      const existing = [...this.items.values()].find((i) =>
        (i.status === "unseen" || i.status === "seen") &&
        i.sourceRef?.kind === sourceRef.kind &&
        i.sourceRef?.id === sourceRef.id
      );
      if (existing) return existing;
    }
    const item = {
```
(The rest of the method body — the `item` object literal from `id: createId("out"),` through `return item;` — is unchanged; only the signature line changes and the dedupe block is inserted before `const item = {`.)
5. [ ] Run `node --test test/outreach-mapper.test.js`. Expect all 8 tests to pass (`# pass 8`, `# fail 0`).
6. [ ] Append this test to the end of `test/outreach-digest.test.js`:
```js
test("unseen skill items roll into the digest", () => {
  const s = store();
  s.append({ type: "skill", sourceRef: { kind: "skill-candidate", id: "sug_1" }, title: "morning-triage" });
  const cfg = normalizeOutreachConfig({}, {});
  const digest = composeDigest(s, cfg, { now: new Date("2026-06-16T12:00:00") });
  assert.ok(digest, "skill items must produce a digest");
  assert.match(digest.title, /1 skill/);
  assert.match(digest.summary, /morning-triage/);
});
```
7. [ ] Run `node --test test/outreach-digest.test.js`. Expect the new test to fail with `AssertionError [ERR_ASSERTION]: skill items must produce a digest` (composeDigest returns `null` because `"skill"` is not yet in `digestTypes`). The 3 existing tests must still pass.
8. [ ] Edit `src/outreach-config.js`. Before (quote exactly):
```js
  digestTypes: ["draft", "suggestion"]
```
After:
```js
  digestTypes: ["draft", "suggestion", "skill"]
```
9. [ ] Run `node --test test/outreach-digest.test.js`. Expect all 4 tests to pass (`# pass 4`, `# fail 0`).
10. [ ] Run the full suite: `npm test`. Expect 0 failures. (Do not read anything under ~/.openagi; all tests use mkdtemp dirs.)
11. [ ] Commit: `git add src/outreach-mapper.js src/outreach-store.js src/outreach-config.js test/outreach-mapper.test.js test/outreach-digest.test.js && git commit -m "feat(outreach): durable skill-candidate outreach items with open-item dedupe"`

### Task A1.2: Route the outreach accept action for skill items to skill materialization
**Week:** 1 · **Size:** M · **Depends on:** A1.1
**User story:** As Spencer (the openAGI owner), I want tapping "accept" on a skill outreach item to actually write the SKILL.md, so that the mine→notify→accept→replay loop closes from the outreach surface with one click.
**Why (evidence):** Verified gap G3: the accept→materialize path exists only behind `POST /proactive/suggestions/:id/accept` (src/hosted-interface.js:1168-1188, calling `createSkillFromCandidate` from src/skill-materialize.js:32); `applyOutreachAction` (src/hosted-interface.js:1497-1532) has no case for skill candidates, so an outreach item pointing at a candidate would fall through the `default:` no-op and be marked "acted" without materializing anything.
**Acceptance criteria:**
- `node --test test/outreach-skill-accept.test.js` passes: POST `/outreach/:id/act` with `{"action":"accept"}` on a `type:"skill"` item creates `<dataDir>/skills/<slug>/SKILL.md`, flips the candidate JSON in `<dataDir>/skills-suggested/` to `status:"accepted"`, and marks the outreach item `acted`; accepting a second item for the same (already-accepted) candidate creates no duplicate skill dir; accepting an item whose candidate file is missing returns 400 and marks the item `error`.
- `npm test` passes with 0 failures.
**Files:**
- Modify: src/hosted-interface.js:1525 (`applyOutreachAction` — insert a `case "skill-candidate":` between `case "clarification":` and `default:`)
- Test: test/outreach-skill-accept.test.js (new file)
**Interfaces:**
- Consumes: `async function applyOutreachAction(runtime, item, action, note)` (src/hosted-interface.js:1497 — invoked by the `POST /outreach/:id/act` route at :674-692, which resolves the item `acted` on success and `error` on throw); `findSuggestion(runtime, id)` and `resolveSuggestion(runtime, id, status, note = null)` (src/suggestion-feed.js:38,44 — miner candidate ids are the file basenames `sug_*`/`ses_*` in `<dataDir>/skills-suggested/`, so `sourceRef.id` from A1.1 maps directly); `createSkillFromCandidate({ runtime, candidate })` → `{ slug, path, scheduleHint }` (src/skill-materialize.js:32, requires `runtime.skills.dirs.length >= 2`; `createDurableRuntime({ dataDir })` sets `skillsDir: path.join(dataDir, "skills")` at src/abi-runtime.js:1064); `runtime.skills.reload()` (src/skills.js:13).
- Produces: `applyOutreachAction` handles `sourceRef.kind === "skill-candidate"` with action `"accept"` (materialize + resolve candidate + reload skills + emit `suggestion-resolved`); throws on any other action so the route 400s. No new exports.

1. [ ] Create `test/outreach-skill-accept.test.js` with exactly this content:
```js
// test/outreach-skill-accept.test.js
// Outreach "accept" on a type:"skill" item must route to the same
// materialization path as POST /proactive/suggestions/:id/accept.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

async function bootApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "out-skill-"));
  process.env.OPENAGI_AUTH_TOKEN = ""; // local, no auth for the test
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0 });
  const listened = await app.listen();
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  return { runtime, app, base, dataDir };
}

// Same shape pattern-miner's persistCandidate writes (src/pattern-miner.js:188-201).
function seedCandidate(dataDir, id) {
  const dir = path.join(dataDir, "skills-suggested");
  fs.mkdirSync(dir, { recursive: true });
  const candidate = {
    id,
    fingerprint: "slack->linear->xcode",
    proposedAt: new Date().toISOString(),
    sequence: { apps: ["Slack", "Linear", "Xcode"], count: 6, startHour: 9, hourVariance: 0.5, occurrences: [] },
    proposal: {
      pass: false,
      name: "morning-triage",
      description: "Morning triage routine across Slack, Linear and Xcode",
      body: "When this routine kicks off, walk through Slack, Linear and Xcode in order.",
      scheduleHint: null
    },
    judgeBypass: false,
    status: "pending"
  };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(candidate, null, 2));
  return candidate;
}

function appendSkillItem(runtime, candidateId, title = "morning-triage") {
  return runtime.outreach.append({
    type: "skill",
    sourceRef: { kind: "skill-candidate", id: candidateId },
    title,
    needsDecision: false,
    actions: ["accept", "dismiss"]
  });
}

function act(base, id, action) {
  return fetch(`${base}/outreach/${id}/act`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action })
  });
}

test("accept on a skill item materializes SKILL.md and resolves the candidate", async () => {
  const { runtime, app, base, dataDir } = await bootApp();
  seedCandidate(dataDir, "sug_test1");
  const item = appendSkillItem(runtime, "sug_test1");
  const res = await act(base, item.id, "accept");
  assert.equal(res.status, 200);
  assert.equal(runtime.outreach.get(item.id).status, "acted");
  const skillPath = path.join(dataDir, "skills", "morning-triage", "SKILL.md");
  assert.ok(fs.existsSync(skillPath), "SKILL.md must be materialized");
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, "skills-suggested", "sug_test1.json"), "utf8"));
  assert.equal(onDisk.status, "accepted");
  await app.close?.();
});

test("accepting a second item for an already-accepted candidate creates no duplicate skill", async () => {
  const { runtime, app, base, dataDir } = await bootApp();
  seedCandidate(dataDir, "sug_test2");
  const a = appendSkillItem(runtime, "sug_test2");
  const b = appendSkillItem(runtime, "sug_test2");
  assert.equal((await act(base, a.id, "accept")).status, 200);
  assert.equal((await act(base, b.id, "accept")).status, 200);
  assert.ok(fs.existsSync(path.join(dataDir, "skills", "morning-triage", "SKILL.md")));
  assert.equal(fs.existsSync(path.join(dataDir, "skills", "morning-triage-2")), false, "no duplicate skill dir");
  await app.close?.();
});

test("accept on a skill item whose candidate is gone returns 400 and marks the item error", async () => {
  const { runtime, app, base } = await bootApp();
  const item = appendSkillItem(runtime, "sug_missing", "ghost");
  const res = await act(base, item.id, "accept");
  assert.equal(res.status, 400);
  assert.equal(runtime.outreach.get(item.id).status, "error");
  await app.close?.();
});
```
2. [ ] Run `node --test test/outreach-skill-accept.test.js`. Expect 3 failures: test 1 fails at `AssertionError [ERR_ASSERTION]: SKILL.md must be materialized` (the current `default:` case in `applyOutreachAction` silently no-ops, so the item is marked "acted" but nothing is written); test 2 fails the same way; test 3 fails with `200 !== 400` (the no-op default never throws).
3. [ ] Edit `src/hosted-interface.js` — insert the `skill-candidate` case in `applyOutreachAction`. Before (quote exactly):
```js
    case "clarification":
      if (!runtime.clarifications?.answer) throw new Error("no clarification store");
      if (!runtime.clarifications.answer(ref.id, action)) throw new Error("clarification not answerable");
      return;
    default:
      return;
```
After:
```js
    case "clarification":
      if (!runtime.clarifications?.answer) throw new Error("no clarification store");
      if (!runtime.clarifications.answer(ref.id, action)) throw new Error("clarification not answerable");
      return;
    case "skill-candidate": {
      // Same materialization path as POST /proactive/suggestions/:id/accept
      // (miner candidates: suggestion-feed envelope + createSkillFromCandidate).
      if (action !== "accept") throw new Error(`unsupported skill-candidate action: ${action}`);
      const { findSuggestion, resolveSuggestion } = await import("./suggestion-feed.js");
      const candidate = findSuggestion(runtime, ref.id);
      if (!candidate) throw new Error("skill candidate gone");
      if (candidate.status === "accepted") return; // already materialized elsewhere — don't write a second skill
      const { createSkillFromCandidate } = await import("./skill-materialize.js");
      createSkillFromCandidate({ runtime, candidate });
      resolveSuggestion(runtime, ref.id, "accepted");
      runtime.skills?.reload?.();
      runtime.events?.emit?.("suggestion-resolved", { id: ref.id, status: "accepted", category: "skill" });
      return;
    }
    default:
      return;
```
4. [ ] Run `node --test test/outreach-skill-accept.test.js`. Expect all 3 tests to pass (`# pass 3`, `# fail 0`).
5. [ ] Run `node --test test/outreach-endpoints.test.js` to confirm the existing act/reply/digest routes are untouched — expect `# pass 7`, `# fail 0`.
6. [ ] Run the full suite: `npm test`. Expect 0 failures.
7. [ ] Commit: `git add src/hosted-interface.js test/outreach-skill-accept.test.js && git commit -m "feat(outreach): accept action on skill outreach items materializes the skill"`

### Task A1.3: Re-ping pending skill items older than 48h via a still-waiting digest section
**Week:** 1 · **Size:** M · **Depends on:** A1.1
**User story:** As Spencer (the openAGI owner), I want skill candidates I ignored to resurface in the digest after 48 hours, so that mined skills don't rot unseen (the live install has 74 candidates that were each surfaced at most once).
**Why (evidence):** Verified gap G3: the only re-ping machinery is task-only — `surfaceStalledTasks` (src/outreach-stalled.js:4-24) filters on `i.type === "stalled-task"` and is fed exclusively by task-sweep's `flaggedTasks` (src/abi-runtime.js:722-723) — and `composeDigest` (src/outreach-digest.js:6-24) reads only `status: "unseen"` items then `markSeen`s them, so a skill item appears in exactly one digest ever. Per the design decision, we extend the digest rather than touching stalled logic.
**Acceptance criteria:**
- `node --test test/outreach-digest.test.js` passes with 3 new tests: a `type:"skill"` item with status `"seen"` and `createdAt` older than 48h reappears in a digest whose title matches `/still-waiting skill/` and whose summary contains a `Still waiting:` header; the same item is not re-pinged again within 24h but is after 24h; a seen skill item younger than 48h triggers nothing.
- The 4 pre-existing digest tests and all of `test/outreach-store.test.js` still pass unchanged.
- `npm test` passes with 0 failures.
- No cron/abi-runtime change: the existing `outreach-digest` job (src/abi-runtime.js:421-425, dispatched at :728 via `composeDigest`) picks the behavior up automatically.
**Files:**
- Modify: src/outreach-store.js:57 (insert `markNudged` method after `markSeen`)
- Modify: src/outreach-digest.js:6 (rewrite `composeDigest`; full file shown below)
- Test: test/outreach-digest.test.js (extend)
**Interfaces:**
- Consumes: `OutreachStore.list({ status })` (src/outreach-store.js:52); `OutreachStore.markSeen(ids = [])` (src/outreach-store.js:57); `OutreachStore.append(...)` and `snapshot()` (src/outreach-store.js:23,79); item fields `type`, `status`, `createdAt` (ISO string, set at append, src/outreach-store.js:36); `config.digestTypes` and `config.inQuietHours(date)` from `normalizeOutreachConfig` (src/outreach-config.js:23-38).
- Produces: `OutreachStore.markNudged(ids = [], { now = new Date() } = {})` — stamps `item.lastNudgedAt` (ISO string) and snapshots; `composeDigest(store, config, { now })` — unchanged signature, now also fires when only still-waiting skill items exist, appends a `Still waiting:` section, and nudges each stale item at most once per 24h. Items gain an optional `lastNudgedAt` field (persisted via the existing snapshot round-trip at src/outreach-store.js:88-93; no migration needed).

1. [ ] Append these three tests to the end of `test/outreach-digest.test.js` (after the test added in A1.1 step 6):
```js
test("seen skill items older than 48h reappear under a still-waiting header", () => {
  const s = store();
  const item = s.append({ type: "skill", sourceRef: { kind: "skill-candidate", id: "sug_old" }, title: "morning-triage" });
  s.markSeen([item.id]);
  s.get(item.id).createdAt = "2026-06-13T12:00:00.000Z"; // 3 days before `now`
  const cfg = normalizeOutreachConfig({}, {});
  const digest = composeDigest(s, cfg, { now: new Date("2026-06-16T12:00:00") });
  assert.ok(digest, "stale skill items must produce a digest");
  assert.match(digest.title, /still-waiting skill/);
  assert.match(digest.summary, /Still waiting:/);
  assert.match(digest.summary, /morning-triage/);
  assert.ok(s.get(item.id).lastNudgedAt, "item must be stamped so it is not re-pinged every cadence");
});

test("still-waiting re-ping happens at most once per 24h", () => {
  const s = store();
  const item = s.append({ type: "skill", sourceRef: { kind: "skill-candidate", id: "sug_np" }, title: "weekly-report" });
  s.markSeen([item.id]);
  s.get(item.id).createdAt = "2026-06-10T12:00:00.000Z";
  const cfg = normalizeOutreachConfig({}, {});
  const first = composeDigest(s, cfg, { now: new Date("2026-06-16T12:00:00") });
  assert.ok(first);
  const oneHourLater = composeDigest(s, cfg, { now: new Date("2026-06-16T13:00:00") });
  assert.equal(oneHourLater, null, "must not re-ping within 24h");
  const nextDay = composeDigest(s, cfg, { now: new Date("2026-06-17T13:00:00") });
  assert.ok(nextDay, "after 24h the item is eligible again");
  assert.match(nextDay.title, /still-waiting skill/);
});

test("seen skill items younger than 48h do not trigger a digest", () => {
  const s = store();
  const item = s.append({ type: "skill", sourceRef: { kind: "skill-candidate", id: "sug_new" }, title: "fresh-skill" });
  s.markSeen([item.id]);
  s.get(item.id).createdAt = new Date(new Date("2026-06-16T12:00:00").getTime() - 24 * 3600 * 1000).toISOString();
  const cfg = normalizeOutreachConfig({}, {});
  assert.equal(composeDigest(s, cfg, { now: new Date("2026-06-16T12:00:00") }), null);
});
```
2. [ ] Run `node --test test/outreach-digest.test.js`. Expect the first two new tests to fail: the first at `AssertionError [ERR_ASSERTION]: stale skill items must produce a digest`, the second at its `assert.ok(first)` line with a generic falsy-value `AssertionError [ERR_ASSERTION]` (composeDigest only reads `status: "unseen"` today, so seen items yield `null` in both); the third new test passes trivially; the 4 existing tests pass.
3. [ ] Edit `src/outreach-store.js` — add `markNudged` directly after `markSeen`. Before (quote exactly):
```js
  markSeen(ids = []) {
    let changed = false;
    for (const id of ids) {
      const i = this.items.get(id);
      if (i && i.status === "unseen") { i.status = "seen"; changed = true; }
    }
    if (changed) this.snapshot();
  }
```
After:
```js
  markSeen(ids = []) {
    let changed = false;
    for (const id of ids) {
      const i = this.items.get(id);
      if (i && i.status === "unseen") { i.status = "seen"; changed = true; }
    }
    if (changed) this.snapshot();
  }

  // Stamp items that were re-listed in a "still waiting" digest section so
  // composeDigest can throttle re-pings (at most one per item per 24h).
  markNudged(ids = [], { now = new Date() } = {}) {
    let changed = false;
    for (const id of ids) {
      const i = this.items.get(id);
      if (i) { i.lastNudgedAt = now.toISOString(); changed = true; }
    }
    if (changed) this.snapshot();
  }
```
4. [ ] Replace the entire content of `src/outreach-digest.js` with:
```js
// src/outreach-digest.js
// Roll unseen, non-decision items into a single digest item, on cadence,
// suppressed during quiet hours. Decisions are delivered live, not here.
// Skill items already digested once ("seen") that the user has ignored for
// 48h+ get re-listed under a "Still waiting" header, at most once per 24h
// each (stamped via store.markNudged), so mined skills don't rot unseen.
function plural(n, word) { return `${n} ${word}${n === 1 ? "" : "s"}`; }

const STILL_WAITING_AGE_MS = 48 * 60 * 60 * 1000;   // skill items older than this get re-pinged
const STILL_WAITING_NUDGE_MS = 24 * 60 * 60 * 1000; // at most one re-ping per item per day

export function composeDigest(store, config, { now = new Date() } = {}) {
  if (config.inQuietHours(now)) return null;
  const pending = store.list({ status: "unseen" })
    .filter((i) => !i.needsDecision && config.digestTypes.includes(i.type));

  const stillWaiting = store.list({ status: "seen" }).filter((i) => {
    if (i.type !== "skill") return false;
    const age = now.getTime() - Date.parse(i.createdAt ?? "");
    if (!Number.isFinite(age) || age < STILL_WAITING_AGE_MS) return false;
    const lastNudge = Date.parse(i.lastNudgedAt ?? "");
    return !Number.isFinite(lastNudge) || (now.getTime() - lastNudge >= STILL_WAITING_NUDGE_MS);
  });

  if (pending.length === 0 && stillWaiting.length === 0) return null;

  const counts = {};
  for (const i of pending) counts[i.type] = (counts[i.type] ?? 0) + 1;
  const parts = Object.entries(counts).map(([type, n]) => plural(n, type));
  if (stillWaiting.length > 0) parts.push(plural(stillWaiting.length, "still-waiting skill"));

  const lines = pending.slice(0, 8).map((i) => `• ${i.title}`);
  if (stillWaiting.length > 0) {
    lines.push("Still waiting:");
    lines.push(...stillWaiting.slice(0, 8).map((i) => `• ${i.title}`));
  }

  const item = store.append({
    type: "digest",
    title: `Your queue: ${parts.join(" · ")}`,
    summary: lines.join("\n"),
    needsDecision: false,
    actions: ["review", "dismiss"]
  });
  store.markSeen(pending.map((i) => i.id));
  store.markNudged?.(stillWaiting.map((i) => i.id), { now });
  return item;
}
```
5. [ ] Run `node --test test/outreach-digest.test.js`. Expect all 7 tests to pass (`# pass 7`, `# fail 0`) — including the 4 pre-existing ones (the rewrite preserves the original title/summary composition for unseen items).
6. [ ] Run `node --test test/outreach-store.test.js` and `node --test test/outreach-endpoints.test.js` to confirm store snapshot round-trip and the read-only `GET /outreach/digest` behavior are unaffected. Expect 0 failures in both.
7. [ ] Run the full suite: `npm test`. Expect 0 failures.
8. [ ] Commit: `git add src/outreach-store.js src/outreach-digest.js test/outreach-digest.test.js && git commit -m "feat(outreach): still-waiting digest re-ping for skill items pending over 48h"`

---

<!-- verified:A2 status=fixed:4 -->
### Task A2: Principle vector GC + intuition-channel filtering
**Week:** 1 · **Size:** M · **Depends on:** none
**User story:** As Spencer (the openAGI owner), I want principle vectors to be deleted when their backing memory item is superseded or evicted, reconciled at boot when orphaned, and filtered out of the intuition channel when stale or quarantined, so that corrected or wiped principles stop surfacing as C2 intuitions in every chat turn.
**Why (evidence):** Gap G10 (confirmed): `VectorStore.delete()` (src/vector-store.js:42) has zero callers anywhere in src/ or test/, so when a principle is superseded via `correct()` (src/memory-system.js:127-178) or cap-evicted (`enforceLimits`, src/memory-system.js:296-308) its vector survives forever. `agent-host.js:115-120` searches the `"principle"` namespace on every `handleMessage()` and injects the top 3 hits filtering only on cosine score — not `supersededBy`, not the condenser's `quarantineUntil` (written into item metadata at src/memory-condenser.js:63), not whether the backing item exists. Live store: 138 principle vectors vs 72 principle items (98 orphans, 71%).
**Acceptance criteria:**
- `node --test test/principle-vector-gc.test.js` exits 0 with 6 passing tests, 0 failing.
- `npm test` exits 0 (same green baseline as before the task — confirm baseline in step 0).
- `grep -c "dropPrincipleVector" src/memory-system.js` prints `3` (one definition, two call sites: `correct()` and `enforceLimits()`).
- `grep -c "reconcilePrincipleVectors" src/abi-runtime.js` prints `2` (method definition + boot call in `createDurableRuntime`).
- On a real daemon boot against a data dir containing orphans, exactly one log line of the form `[openagi] principle-vector reconcile: removed N of M vectors (orphaned or superseded)` appears (counts only — never log or read item content; do NOT inspect the contents of ~/.openagi to verify this, the boot-reconcile test added in step 9 covers the behavior).
**Files:**
- Modify: src/memory-system.js:16 (constructor), src/memory-system.js:172-178 (`correct()` supersede loop), src/memory-system.js:296-308 (`enforceLimits`)
- Modify: src/abi-runtime.js:162 (vector-store binding), src/abi-runtime.js:~1007 (insert method before `status()`), src/abi-runtime.js:1096 (boot call after `applyPersona`)
- Modify: src/agent-host.js:115-120 (intuition search), src/agent-host.js:~370 (insert `filterPrincipleHits` before `verdictGuidance`)
- Test: test/principle-vector-gc.test.js (new)
**Interfaces:**
- Consumes: `VectorStore.delete(namespace, id)` → boolean (src/vector-store.js:42); `VectorStore.upsert(namespace, id, text, payload = {})` (async, src/vector-store.js:27); `VectorStore.search(namespace, queryText, { limit = 5, minScore = 0.05 } = {})` (async, src/vector-store.js:49); `VectorStore.list(namespace)` (src/vector-store.js:67); the condenser's vector id scheme `vectorStore.upsert("principle", item.id, principle.text, {...})` where `item.id` is the memory item id (src/memory-condenser.js:71); `MemorySystem.correct({ id, query, content, tags, scope, source, metadata })` (src/memory-system.js:127); `memory.items` (a `Map` of id → item); existing binding style `if (typeof this.propagation.bindVectorStore === "function") this.propagation.bindVectorStore(this.vectorStore);` (src/abi-runtime.js:162).
- Produces: `MemorySystem.bindVectorStore(vectorStore)` (setter, returns undefined); `MemorySystem.dropPrincipleVector(id)` → boolean; `AbiRuntime.reconcilePrincipleVectors()` → `{ checked: number, removed: number }`; exported `filterPrincipleHits(hits, memory, { limit = 3, now = Date.now() } = {})` → filtered hits array (same `{ id, score, text, payload }` shape as `VectorStore.search` results), from src/agent-host.js.

#### Steps

1. [ ] Confirm a green baseline. Run `npm test` from /Users/you/Dev/openAGI. Expect exit code 0 and `# fail 0` in the summary. If anything fails before you change code, STOP and report — do not proceed on a red baseline.

2. [ ] Write the failing tests for supersede-GC and evict-GC. Create the file `/Users/you/Dev/openAGI/test/principle-vector-gc.test.js` with exactly this content:

```js
// G10 remediation: principle vectors must be garbage-collected when their
// backing memory item is superseded (correct()) or cap-evicted
// (enforceLimits), reconciled at boot when orphaned, and filtered out of the
// C2 intuition channel when missing, superseded, or quarantined.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  HashBagEmbedder,
  MemorySystem,
  VectorStore,
  createDefaultRuntime,
  createDurableRuntime
} from "../src/index.js";
import { AgentHost } from "../src/agent-host.js";

function tmpVectorStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-pvgc-"));
  return new VectorStore({ embedder: new HashBagEmbedder(), dir });
}

test("correct() deletes the superseded item's principle vector", async () => {
  const memory = new MemorySystem();
  const vectors = tmpVectorStore();
  memory.bindVectorStore(vectors);

  const principle = memory.remember(
    { content: "Standup meetings are at 9am Mondays.", tags: ["principle", "standup"], kind: "principle" },
    { tier: "long" }
  );
  await vectors.upsert("principle", principle.id, principle.content, { confidence: "high" });
  assert.equal(vectors.list("principle").length, 1);

  const { superseded } = memory.correct({ id: principle.id, content: "Standup meetings moved to 9:30am Mondays." });

  assert.equal(superseded[0].id, principle.id);
  assert.equal(vectors.list("principle").length, 0, "superseding a principle removes its vector");
});

test("cap eviction deletes the evicted item's principle vector", async () => {
  const memory = new MemorySystem({ limits: { short: 100, medium: 100, long: 1 } });
  const vectors = tmpVectorStore();
  memory.bindVectorStore(vectors);

  const weak = memory.remember(
    { content: "Old principle: check the calendar before booking anything.", kind: "principle" },
    { tier: "long", strength: 0.1 }
  );
  await vectors.upsert("principle", weak.id, weak.content);
  assert.equal(vectors.list("principle").length, 1);

  // Long-tier cap is 1: this stronger item evicts the weak principle.
  memory.remember({ content: "Newer long-term note that wins the cap." }, { tier: "long", strength: 0.9 });

  assert.equal(memory.items.has(weak.id), false, "weaker item was evicted");
  assert.equal(vectors.list("principle").length, 0, "evicted item's vector removed");
});
```

3. [ ] Run the new test file: `node --test test/principle-vector-gc.test.js`. Expect BOTH tests to fail with `TypeError: memory.bindVectorStore is not a function` (summary shows `# fail 2`). If they fail with a different error, fix the test file until the failure is exactly this missing method.

4. [ ] Implement the vector binding on MemorySystem. In `/Users/you/Dev/openAGI/src/memory-system.js`, find this exact text (constructor, lines 17-19):

```js
    this.items = new Map();
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
    this.ttlMs = { ...DEFAULT_TTL_MS, ...(options.ttlMs ?? {}) };
```

and replace it with:

```js
    this.items = new Map();
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
    this.ttlMs = { ...DEFAULT_TTL_MS, ...(options.ttlMs ?? {}) };
    // Optional VectorStore for principle-vector GC; see bindVectorStore().
    this.vectors = null;
```

Then, in the same file, find this exact text (line 22):

```js
  remember(observation, context = {}) {
```

and replace it with:

```js
  // Late-bound by AbiRuntime once the VectorStore exists (memory is
  // constructed before the vector store). When bound, items that leave
  // retrieval (superseded by correct(), cap-evicted by enforceLimits) also
  // drop their "principle"-namespace vector, so stale principles stop
  // surfacing through the C2 intuition channel.
  bindVectorStore(vectorStore) {
    this.vectors = vectorStore;
  }

  // Best-effort: VectorStore.delete persists synchronously and returns false
  // when the key is absent (non-principle items are a cheap no-op).
  dropPrincipleVector(id) {
    if (!this.vectors) return false;
    try {
      return this.vectors.delete("principle", id);
    } catch {
      return false;
    }
  }

  remember(observation, context = {}) {
```

5. [ ] Wire GC into `correct()`. In `/Users/you/Dev/openAGI/src/memory-system.js`, find this exact text (lines 172-175):

```js
    const at = nowIso();
    for (const target of targets) {
      target.metadata = { ...target.metadata, supersededBy: corrected.id, supersededAt: at };
    }
```

and replace it with:

```js
    const at = nowIso();
    for (const target of targets) {
      target.metadata = { ...target.metadata, supersededBy: corrected.id, supersededAt: at };
      this.dropPrincipleVector(target.id);
    }
```

6. [ ] Wire GC into `enforceLimits()`. In `/Users/you/Dev/openAGI/src/memory-system.js`, find this exact text (lines 306-307):

```js
      .slice(0, Math.max(0, tierItems.length - limit))
      .forEach((item) => this.items.delete(item.id));
```

and replace it with:

```js
      .slice(0, Math.max(0, tierItems.length - limit))
      .forEach((item) => {
        this.items.delete(item.id);
        this.dropPrincipleVector(item.id);
      });
```

7. [ ] Bind memory to the vector store at runtime construction (least-invasive wiring: `AbiRuntime` constructs memory at src/abi-runtime.js:127, before the vector store at line 161, so a post-construction setter matching the existing `propagation.bindVectorStore` style is the right shape — do NOT add a constructor option). In `/Users/you/Dev/openAGI/src/abi-runtime.js`, find this exact text (line 162):

```js
    if (typeof this.propagation.bindVectorStore === "function") this.propagation.bindVectorStore(this.vectorStore);
```

and replace it with:

```js
    if (typeof this.propagation.bindVectorStore === "function") this.propagation.bindVectorStore(this.vectorStore);
    // Memory drops "principle" vectors when items are superseded or evicted;
    // memory is constructed before the vector store, so bind it here.
    if (typeof this.memory.bindVectorStore === "function") this.memory.bindVectorStore(this.vectorStore);
```

Note: `FileBackedMemorySystem` (src/file-backed-memory-system.js) extends `MemorySystem` and overrides `correct()` via `super.correct(input)`, so it inherits both new methods with no changes to that file.

8. [ ] Run `node --test test/principle-vector-gc.test.js`. Expect both tests to pass (`# pass 2`, `# fail 0`). Then run the full suite: `npm test` — expect exit code 0, `# fail 0`. Then commit:
`git add src/memory-system.js src/abi-runtime.js test/principle-vector-gc.test.js && git commit -m "fix(memory): delete principle vectors when items are superseded or cap-evicted (G10)"`

9. [ ] Write the failing reconcile tests. Append exactly this to the END of `/Users/you/Dev/openAGI/test/principle-vector-gc.test.js`:

```js
test("reconcilePrincipleVectors removes orphaned and superseded vectors, keeps live ones", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-pvgc-rec-"));
  const runtime = createDefaultRuntime({
    agentHost: false,
    embedderOptions: { forceHash: true },
    vectorStoreOptions: { dir }
  });

  const live = runtime.memory.remember({ content: "Live principle about calendar hygiene.", kind: "principle" }, { tier: "long" });
  await runtime.vectorStore.upsert("principle", live.id, live.content);
  await runtime.vectorStore.upsert("principle", "mem_long_wiped_1", "Orphan principle whose memory item is gone.");
  const stale = runtime.memory.remember({ content: "Stale principle later corrected.", kind: "principle" }, { tier: "long" });
  await runtime.vectorStore.upsert("principle", stale.id, stale.content);
  // Simulate a supersede that happened before the GC wiring existed.
  stale.metadata = { ...stale.metadata, supersededBy: "mem_medium_fake_1" };

  const result = runtime.reconcilePrincipleVectors();

  assert.equal(result.checked, 3);
  assert.equal(result.removed, 2);
  assert.deepEqual(runtime.vectorStore.list("principle").map((e) => e.id), [live.id]);
});

test("createDurableRuntime reconciles orphaned principle vectors at boot", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-pvgc-boot-"));
  const seed = new VectorStore({ embedder: new HashBagEmbedder(), dir: path.join(dataDir, "vectors") });
  await seed.upsert("principle", "mem_long_wiped_2", "Orphan vector from a wiped memory state.");

  const runtime = createDurableRuntime({
    dataDir,
    agentHost: false,
    autoConnectMcp: false,
    embedderOptions: { forceHash: true }
  });

  assert.equal(runtime.vectorStore.list("principle").length, 0, "boot reconcile removed the orphan");
});
```

10. [ ] Run `node --test test/principle-vector-gc.test.js`. Expect the first two tests to still pass and the two new tests to fail: `TypeError: runtime.reconcilePrincipleVectors is not a function` (summary `# pass 2`, `# fail 2`).

11. [ ] Implement the reconcile method on `AbiRuntime`. Placement decision (already made — do not revisit): the method lives on `AbiRuntime` so tests and any entry point can call it, and the automatic invocation goes in `createDurableRuntime` (src/abi-runtime.js:1059+), NOT in `src/migrate.js` (that file is an OpenClaw/Hermes install importer, unrelated to boot) and NOT in `src/boot.js` (which just calls `createDurableRuntime` at src/boot.js:87 — putting it in `createDurableRuntime` covers `openagi serve`, the hosted example, and the CLI identically, and both `FileBackedMemorySystem.load()` and the `VectorStore` snapshot load run inside their constructors, so both stores are fully live by then). In `/Users/you/Dev/openAGI/src/abi-runtime.js`, find this exact text (the start of `AbiRuntime.status()`, ~line 1007):

```js
  status() {
    return {
      context: this.context,
```

and replace it with:

```js
  // Boot reconciliation for the C2 intuition channel: principle vectors whose
  // backing memory item is gone (memory-state reset, pre-wiring eviction) or
  // superseded (corrected) would otherwise surface as intuitions forever --
  // VectorStore entries have no TTL. Synchronous and cheap: both stores are
  // in-memory maps by the time this runs. Logs one line, counts only.
  reconcilePrincipleVectors() {
    if (!this.vectorStore || !this.memory?.items) return { checked: 0, removed: 0 };
    const entries = this.vectorStore.list("principle");
    let removed = 0;
    for (const entry of entries) {
      const item = this.memory.items.get(entry.id);
      if (!item || item.metadata?.supersededBy) {
        this.vectorStore.delete("principle", entry.id);
        removed += 1;
      }
    }
    if (removed > 0) {
      console.log(`[openagi] principle-vector reconcile: removed ${removed} of ${entries.length} vectors (orphaned or superseded)`);
    }
    return { checked: entries.length, removed };
  }

  status() {
    return {
      context: this.context,
```

12. [ ] Invoke it at durable boot. In `/Users/you/Dev/openAGI/src/abi-runtime.js`, find this exact text (line 1096, inside `createDurableRuntime`):

```js
  applyPersona(runtime, dataDir);
```

and replace it with:

```js
  applyPersona(runtime, dataDir);
  // GC orphaned/superseded principle vectors before the first turn injects
  // intuitions (memory + vector snapshots are both loaded by now).
  runtime.reconcilePrincipleVectors();
```

13. [ ] Run `node --test test/principle-vector-gc.test.js` — expect `# pass 4`, `# fail 0`. Run `npm test` — expect exit code 0, `# fail 0`. Commit:
`git add src/abi-runtime.js test/principle-vector-gc.test.js && git commit -m "fix(memory): reconcile orphaned and superseded principle vectors at boot (G10)"`

14. [ ] Write the failing inject-time-filter tests. First, in `/Users/you/Dev/openAGI/test/principle-vector-gc.test.js`, find this exact text:

```js
import { AgentHost } from "../src/agent-host.js";
```

and replace it with:

```js
import { AgentHost, filterPrincipleHits } from "../src/agent-host.js";
```

Then append exactly this to the END of the same test file:

```js
test("filterPrincipleHits drops missing, superseded, and quarantined hits; top-N cut applies after filtering", async () => {
  const memory = new MemorySystem();
  const vectors = tmpVectorStore();
  const addPrinciple = async (content, metadata = {}) => {
    const item = memory.remember({ content, kind: "principle", metadata }, { tier: "long" });
    await vectors.upsert("principle", item.id, content);
    return item;
  };

  const liveA = await addPrinciple("Standup meeting principle A: schedule prep before standup meetings.");
  const liveB = await addPrinciple("Standup meeting principle B: schedule notes after standup meetings.");
  const liveC = await addPrinciple("Standup meeting principle C: schedule follow-ups from standup meetings.");
  const expired = await addPrinciple("Standup meeting principle D: schedule demos in standup meetings.", {
    quarantineUntil: new Date(Date.now() - 86400 * 1000).toISOString()
  });
  const superseded = await addPrinciple("Standup meeting principle E: superseded standup meetings advice.");
  superseded.metadata = { ...superseded.metadata, supersededBy: "mem_medium_fake_2" };
  const quarantined = await addPrinciple("Standup meeting principle F: quarantined standup meetings hunch.", {
    quarantineUntil: new Date(Date.now() + 86400 * 1000).toISOString()
  });
  await vectors.upsert("principle", "mem_long_missing_9", "Standup meeting principle G: orphaned standup meetings vector.");

  const hits = await vectors.search("principle", "schedule standup meetings", { limit: 20, minScore: 0 });
  assert.equal(hits.length, 7);

  const eligible = filterPrincipleHits(hits, memory, { limit: 10 });
  const ids = eligible.map((h) => h.id);
  assert.equal(eligible.length, 4, "only live + expired-quarantine principles remain");
  assert.deepEqual(ids.slice().sort(), [liveA.id, liveB.id, liveC.id, expired.id].sort());
  assert.ok(!ids.includes(superseded.id));
  assert.ok(!ids.includes(quarantined.id));
  assert.ok(!ids.includes("mem_long_missing_9"));

  const capped = filterPrincipleHits(hits, memory, { limit: 3 });
  assert.equal(capped.length, 3, "top-3 cut applies AFTER filtering");
});

test("handleMessage injects live principles but never quarantined ones", async () => {
  const memory = new MemorySystem();
  const vectors = tmpVectorStore();
  memory.bindVectorStore(vectors);

  const live = memory.remember(
    { content: "Standup meetings run at 9am; block prep time before standup meetings.", kind: "principle" },
    { tier: "long" }
  );
  await vectors.upsert("principle", live.id, live.content);
  const quarantined = memory.remember(
    {
      content: "Quarantined hunch: cancel standup meetings on Fridays.",
      kind: "principle",
      metadata: { quarantineUntil: new Date(Date.now() + 86400 * 1000).toISOString() }
    },
    { tier: "long" }
  );
  await vectors.upsert("principle", quarantined.id, quarantined.content);

  const captured = {};
  const runtime = {
    memory,
    vectorStore: vectors,
    outcomes: null,
    processSignal: () => ({
      id: "out_1",
      scrutiny: { action: "act", score: 0.7, reasons: ["stub"], dimensions: { novelty: 0.4, risk: 0.3, repetition: 0.3 } },
      customContext: [],
      propagation: { created: false }
    })
  };
  const host = new AgentHost({
    runtime,
    modelProvider: {
      isConfigured: () => true,
      model: "stub",
      generate: async (args) => {
        captured.instructions = args.instructions;
        return { text: "ok", provider: "stub", model: "stub", id: "r1", toolCalls: [] };
      }
    }
  });

  await host.handleMessage({ text: "when do standup meetings run?", channel: "local", from: "u" });

  assert.match(captured.instructions, /block prep time before standup meetings/, "live principle injected as intuition");
  assert.doesNotMatch(captured.instructions, /Quarantined hunch/, "quarantined principle NOT injected");
});
```

(The stub runtime + capturing model provider pattern matches test/verdict-consequences.test.js:85-113 — `AgentHost.handleMessage` guards every other runtime dependency with optional chaining, so `memory`, `vectorStore`, `outcomes`, and `processSignal` are the only fields needed.)

15. [ ] Run `node --test test/principle-vector-gc.test.js`. Expect the ENTIRE file to fail to load with `SyntaxError: The requested module '../src/agent-host.js' does not provide an export named 'filterPrincipleHits'` (this is the red state — none of the 6 tests run).

16. [ ] Implement the filter. In `/Users/you/Dev/openAGI/src/agent-host.js`, find this exact text (module-level, ~line 370, the comment above `verdictGuidance`):

```js
// What each scrutiny verdict means for THIS turn — matches the enforcement
```

and replace it with:

```js
// C2 intuition hygiene: a vector hit is only injectable when its backing
// memory item still exists, has not been superseded by a correction, and is
// past the condenser's quarantine window (metadata.quarantineUntil, written
// by MemoryCondenser). The top-N cut happens AFTER this filter so a stale
// vector can't crowd out a live principle.
export function filterPrincipleHits(hits, memory, { limit = 3, now = Date.now() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const out = [];
  for (const hit of hits ?? []) {
    const item = memory?.items?.get?.(hit.id);
    if (!item) continue;
    if (item.metadata?.supersededBy) continue;
    const quarantineUntil = item.metadata?.quarantineUntil;
    if (quarantineUntil && new Date(quarantineUntil).getTime() > nowMs) continue;
    out.push(hit);
    if (out.length >= limit) break;
  }
  return out;
}

// What each scrutiny verdict means for THIS turn — matches the enforcement
```

17. [ ] Wire the filter into the turn path. In `/Users/you/Dev/openAGI/src/agent-host.js`, find this exact text (lines 115-120):

```js
    let intuitions = [];
    if (this.runtime.vectorStore) {
      try {
        intuitions = await this.runtime.vectorStore.search("principle", text, { limit: 3, minScore: 0.1 });
      } catch { /* best effort */ }
    }
```

and replace it with:

```js
    let intuitions = [];
    if (this.runtime.vectorStore) {
      try {
        // Over-fetch, then drop hits whose backing memory item is missing,
        // superseded, or still quarantined — the top-3 cut happens AFTER
        // filtering so stale vectors can't crowd out live principles.
        const rawHits = await this.runtime.vectorStore.search("principle", text, { limit: 10, minScore: 0.1 });
        intuitions = filterPrincipleHits(rawHits, this.runtime.memory, { limit: 3 });
      } catch { /* best effort */ }
    }
```

18. [ ] Run `node --test test/principle-vector-gc.test.js` — expect `# pass 6`, `# fail 0`. Run `npm test` — expect exit code 0, `# fail 0`.

19. [ ] Commit and push:
`git add src/agent-host.js test/principle-vector-gc.test.js && git commit -m "fix(agent-host): filter superseded, quarantined, and orphaned principles from intuition injection (G10)" && git push`

---

<!-- verified:A3 status=fixed:2 -->
### Task A3: Capture client mode — decision gate + Option A runbook (point the eyes at the chosen brain)
**Week:** 1 · **Size:** S · **Depends on:** none
**User story:** As Spencer (the openAGI owner), I want exactly one brain (main) receiving my ambient capture stream, so that the Distiller main and the Mac's local daemon stop accumulating divergent memories ("two-brain cancerous multiplication").
**Why (evidence):** Gap G6 (confirmed): `mac/Sources/OpenAGI/Capture/CaptureBridge.swift:38` POSTs capture to hardcoded `http://127.0.0.1:43210/observations` under a `TODO(roadmap/remote-capture)` (lines 33–37), and `mac/Sources/OpenAGI/AppState.swift:14` hardcodes the same base URL, while the live `~/.openagi/node.json` pairs this Mac to a remote Distiller main at `192.0.2.30:43210`. The pairing is honored only by the CLI (`src/cli-client.js:62-66`); no `sourceMachineId` exists anywhere in `src/`, `mac/`, or `test/`. The same app already has remote-main plumbing for outreach (`AppState.outreachRemoteURL` → `OutreachConsumer`, `AppState.swift:31-44`), so proactive decisions arrive from a brain that cannot see the screen.

⚠️ **DECISION GATE — STOP AND ASK SPENCER BEFORE ANY IMPLEMENTATION.** Present exactly these two options and wait for his answer:

> **Option A — declare this Mac the main (config flip, no code).** Unpair from the Distiller; everything (capture, memory, outreach) stays local on this Mac, which already runs a full daemon with 742MB of observations. Zero code risk; the Distiller's separately-accumulated brain is orphaned (decommissioning it is a separate decision). Executed as the runbook below, interactively with you.
> **Option B — remote capture (code).** Implement the ROADMAP remote-capture items so this Mac streams capture to the Distiller main: configurable daemon URL + token in the Mac app, a persistent `sourceMachineId` stamped on every batch, daemon-side `source_machine_id` storage, and a machine filter on `recall_activity`. Tasks A3.1–A3.4. Requires deploying the updated daemon on the Distiller too.

If Spencer picks **Option A**: complete this task fully (write the runbook doc, commit it, then walk the runbook with Spencer) and **skip tasks A3.1–A3.4 entirely**. If Spencer picks **Option B**: still write and commit the runbook doc in this task (it documents the alternative and the reversal path), do **not** execute the runbook's unpair steps, and proceed to A3.1–A3.4.

**Acceptance criteria:**
- Spencer has been asked the Option A / Option B question and his answer is recorded in the final report.
- `docs/runbooks/declare-this-mac-main.md` exists with the exact content below and is committed.
- If Option A was chosen: `openagi doctor` run on this Mac prints a first check line containing `local daemon → http://127.0.0.1:43210 (via local)` (not `via node.json`), and `~/.openagi/node.json.bak` exists.

**Files:**
- Create: docs/runbooks/declare-this-mac-main.md
**Interfaces:**
- Consumes: `openagi unpair` CLI command (bin/openagi.js:383 → `cmdUnpair()` → `clearNodeConfig(resolveDataDir())`, prints `✓ unpaired — commands target the local daemon again.`); `openagi doctor` target line format from `runDoctor` (src/cli-client.js:144): `` `${target.remote ? "remote main" : "local daemon"} → ${target.url} (via ${target.source})` ``
- Produces: nothing programmatic; a committed runbook document.

1. [ ] Ask Spencer the decision-gate question above (verbatim options A and B). Do not proceed until answered. Record the answer.
2. [ ] Create `docs/runbooks/declare-this-mac-main.md` with exactly this content:

````markdown
# Runbook: declare this Mac the main (unpair from a remote Distiller)

Use this when a Mac that runs the full packaged OpenAGI app (its own daemon,
memory, outcomes, and 700MB+ of observations) is still *paired* to a remote
main via `~/.openagi/node.json`. The pairing only redirects the `openagi` CLI;
capture, memory, and the agent already run locally. Unpairing makes the local
daemon the single brain on purpose instead of by accident.

Everything below is a config flip — no code changes, nothing deleted without a
backup. Run each step yourself; where a value comes from `~/.openagi/.env`,
open that file yourself and do not paste secrets into an agent chat.

## Checklist

1. **Confirm a pairing exists.**
   ```sh
   ls -l ~/.openagi/node.json
   openagi doctor
   ```
   Expected: the file exists, and doctor's first check reads
   `remote main → http://<distiller-host>:43210 (via node.json)`.
   If doctor already says `local daemon → ... (via local)`, stop — nothing to do.

2. **Back up the pairing (reversal insurance).**
   ```sh
   cp ~/.openagi/node.json ~/.openagi/node.json.bak
   ```

3. **Unpair.**
   ```sh
   openagi unpair
   ```
   Expected output: `✓ unpaired — commands target the local daemon again.`

4. **Verify the CLI now targets the local daemon.**
   ```sh
   openagi doctor
   ```
   Expected: first check reads `local daemon → http://127.0.0.1:43210 (via local)`
   and the `daemon` check reads `reachable + authorized`.

5. **Repoint the Mac app's outreach consumer at the local daemon.**
   The menubar app's proactive-outreach feed may still point at the Distiller
   (UserDefaults `outreachRemoteURL`). Check, then repoint:
   ```sh
   defaults read app.openagi.daemon outreachRemoteURL
   defaults write app.openagi.daemon outreachRemoteURL "http://127.0.0.1:43210"
   defaults write app.openagi.daemon outreachToken "<OPENAGI_AUTH_TOKEN from ~/.openagi/.env — open the file yourself>"
   ```
   Then quit and relaunch the OpenAGI menubar app so `AppDelegate` reconfigures
   `OutreachConsumer` with the new URL.
   (If `defaults read` errors with "does not exist", outreach was never remote —
   still run the two `defaults write` commands so outreach notifications flow
   from the local brain.)

6. **Verify capture still lands locally (counts only).**
   ```sh
   TOKEN="<OPENAGI_AUTH_TOKEN from ~/.openagi/.env>"
   curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:43210/observations/stats
   ```
   Note the `activity` count, use the Mac for a minute, re-run: the count rises.

7. **Decide the Distiller's fate (separate decision, out of scope here).**
   The main at the old remote URL keeps its own memory/outcomes/integrations.
   Nothing on this Mac reads from it after steps 3–5. Options: keep it running
   as an independent install, or stop its daemon. Do not delete its data dir
   without a separate backup decision.

## Reversal

```sh
cp ~/.openagi/node.json.bak ~/.openagi/node.json
# or re-pair from scratch:
openagi pair http://<distiller-host>:43210 --token "<the main's OPENAGI_AUTH_TOKEN>"
```
````
3. [ ] Commit the doc: `git add docs/runbooks/declare-this-mac-main.md && git commit -m "docs(capture): runbook for declaring this Mac the main (option A of capture client mode)"` then `git push`.
4. [ ] If Spencer chose **Option A**: walk him through the runbook steps 1–6 now, one at a time, confirming each expected output before the next. Do not run `openagi unpair` or any `defaults write` yourself without showing Spencer the exact command first and getting a yes. Record each observed output. Skip tasks A3.1–A3.4.
5. [ ] If Spencer chose **Option B**: proceed to Task A3.1.

---

### Task A3.1: Mac capture — configurable daemon base URL + token (Option B)
**Week:** 1 · **Size:** M · **Depends on:** A3 (gate answered: Option B)
**User story:** As Spencer, I want the Mac app's capture bridge to stream observation batches to a configurable daemon URL with its own token, so that this Mac can act as the eyes of the remote Distiller main instead of only its own local daemon.
**Why (evidence):** G6: the capture target is hardcoded at `mac/Sources/OpenAGI/Capture/CaptureBridge.swift:38` (`http://127.0.0.1:43210/observations`) under `TODO(roadmap/remote-capture)` at lines 33–37, which itself says the fix is "a settings field + UserDefaults". The outreach feature already ships this exact pattern (`AppState.swift:31-44`: UserDefaults-persisted `outreachRemoteURL`/`outreachToken` + a setter) — mirror it.

**Acceptance criteria:**
- `swift build --package-path /Users/you/Dev/openAGI/mac` exits 0 printing `Build complete!`.
- With UserDefaults key `daemonBaseURL` unset, capture batches still POST to `http://127.0.0.1:43210/observations` (verified via local `/observations/stats` counts rising).
- With `daemonBaseURL` set to the Distiller URL and `daemonToken` set to the main's token, batches land on the remote main (verified via the remote `/observations/stats` counts rising) and stop landing locally.

**Files:**
- Modify: mac/Sources/OpenAGI/AppState.swift:44 (insert after the `setOutreachMain` function)
- Modify: mac/Sources/OpenAGI/Capture/CaptureBridge.swift:33 (TODO block + URL) and :79 (tokenSafe)
- Test: none (no Swift test harness in this repo — build + manual verification below)

**Interfaces:**
- Consumes: `AppState.shared.authToken() -> String?` (AppState.swift:101); `CaptureStorage.shared.unpushedBatch(limit: 100)` and `CaptureStorage.shared.markPushed(activityIds:frameIds:)` (unchanged); UserDefaults pattern from `@Published var outreachRemoteURL: String = UserDefaults.standard.string(forKey: "outreachRemoteURL") ?? ""` (AppState.swift:35)
- Produces: `AppState.captureRemoteURL: String` and `AppState.captureRemoteToken: String` (UserDefaults keys `daemonBaseURL`, `daemonToken`); `AppState.setCaptureMain(url: String, token: String)`; CaptureBridge private helpers `captureBaseSafe() async -> String` and revised `tokenSafe() async -> String?`. Task A3.3 edits the same file.

1. [ ] In `mac/Sources/OpenAGI/AppState.swift`, insert new state directly after the existing `setOutreachMain` function. Before (current code, lines 38–44):
```swift
  func setOutreachMain(url: String, token: String) {
    outreachRemoteURL = url
    outreachToken = token
    UserDefaults.standard.set(url, forKey: "outreachRemoteURL")
    UserDefaults.standard.set(token, forKey: "outreachToken")
    OutreachConsumer.shared.reconfigure(url: url, token: token)
  }
```
After:
```swift
  func setOutreachMain(url: String, token: String) {
    outreachRemoteURL = url
    outreachToken = token
    UserDefaults.standard.set(url, forKey: "outreachRemoteURL")
    UserDefaults.standard.set(token, forKey: "outreachToken")
    OutreachConsumer.shared.reconfigure(url: url, token: token)
  }

  // Remote capture target. When set, CaptureBridge streams observation batches
  // to this URL/token (a remote main) instead of the local daemon above — this
  // Mac becomes a capture node. Persisted in UserDefaults; seeded by the wizard
  // or: defaults write app.openagi.daemon daemonBaseURL "http://host:43210"
  // Mirrors the outreachRemoteURL plumbing directly above.
  @Published var captureRemoteURL: String = UserDefaults.standard.string(forKey: "daemonBaseURL") ?? ""
  @Published var captureRemoteToken: String = UserDefaults.standard.string(forKey: "daemonToken") ?? ""

  func setCaptureMain(url: String, token: String) {
    captureRemoteURL = url
    captureRemoteToken = token
    UserDefaults.standard.set(url, forKey: "daemonBaseURL")
    UserDefaults.standard.set(token, forKey: "daemonToken")
  }
```
2. [ ] In `mac/Sources/OpenAGI/Capture/CaptureBridge.swift`, replace the TODO block and URL. Before (current code, lines 33–44):
```swift
    // TODO(roadmap/remote-capture): make this configurable so the Mac
    // can run as a capture-only client streaming to a remote daemon
    // (e.g. a home Mac mini). Plumbing to a remote URL + bearer token
    // is the same as localhost; just a settings field + UserDefaults.
    // See docs/ROADMAP.md for the full design.
    let url = URL(string: "http://127.0.0.1:43210/observations")!
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    if let token = await tokenSafe() {
      req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
```
After:
```swift
    // Capture target is configurable (UserDefaults "daemonBaseURL", seeded by
    // the wizard or a defaults-write). Empty/missing means the local daemon,
    // exactly the pre-existing behavior.
    let base = await captureBaseSafe()
    guard let url = URL(string: base + "/observations") else {
      NSLog("OpenAGI bridge: invalid capture base URL: \(base)")
      return
    }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    if let token = await tokenSafe() {
      req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
```
3. [ ] In the same file, replace `tokenSafe` and add the base-URL helper. Before (current code, lines 79–82):
```swift
  @MainActor
  private func tokenSafe() async -> String? {
    AppState.shared.authToken()
  }
```
After:
```swift
  @MainActor
  private func captureBaseSafe() async -> String {
    let raw = AppState.shared.captureRemoteURL.trimmingCharacters(in: .whitespaces)
    if raw.isEmpty { return "http://127.0.0.1:43210" }
    return raw.hasSuffix("/") ? String(raw.dropLast()) : raw
  }

  // Remote capture authenticates with the remote main's token; local capture
  // keeps using the local env-file token (same split OutreachConsumer uses).
  @MainActor
  private func tokenSafe() async -> String? {
    let remoteURL = AppState.shared.captureRemoteURL.trimmingCharacters(in: .whitespaces)
    if !remoteURL.isEmpty, !AppState.shared.captureRemoteToken.isEmpty {
      return AppState.shared.captureRemoteToken
    }
    return AppState.shared.authToken()
  }
```
4. [ ] Build: `swift build --package-path /Users/you/Dev/openAGI/mac`. Expected: dependency fetch (Sparkle) on first run, then `Build complete!` and exit code 0. If it fails, the error will name the exact file/line — fix only that and rebuild.
5. [ ] Manual verification (with Spencer — packaged app required, because the UserDefaults domain belongs to the app bundle and screen-capture permissions are bound to it):
   - a. Confirm the defaults domain: `defaults domains | tr ',' '\n' | grep -i openagi` → expected to print `app.openagi.daemon` (the domain outreach already uses; if a different openagi domain prints, substitute it in every command below).
   - b. Build the app: `./scripts/build-mac-app.sh` from the repo root → produces `build/OpenAGI.app`. Ask Spencer to quit the running OpenAGI menubar app and launch the new build (do not kill the app yourself).
   - c. Default (unset) behavior: ensure `defaults read app.openagi.daemon daemonBaseURL` errors with "does not exist". Run `curl -s -H "Authorization: Bearer <token Spencer reads from ~/.openagi/.env>" http://127.0.0.1:43210/observations/stats`, note the `activity` count, wait ~60s of normal Mac use, re-run: count rises. Capture still lands locally.
   - d. Remote behavior: `defaults write app.openagi.daemon daemonBaseURL "http://192.0.2.30:43210"` and `defaults write app.openagi.daemon daemonToken "<the Distiller main's OPENAGI_AUTH_TOKEN, supplied by Spencer>"`; Spencer relaunches the app. On the remote: `curl -s -H "Authorization: Bearer <remote token>" http://192.0.2.30:43210/observations/stats` → `activity` count rises within ~60s, while the local count from step c stops rising. (If the tailnet TCP connection is dead, a local VPN is the usual cause — see memory note — have Spencer check NordVPN/PairVPN before debugging the code.)
   - e. Leave the defaults in whichever state Spencer wants as the end state (remote, for Option B).
6. [ ] Commit: `git add mac/Sources/OpenAGI/AppState.swift mac/Sources/OpenAGI/Capture/CaptureBridge.swift && git commit -m "feat(mac/capture): configurable daemon base URL and token for the capture bridge"` then `git push`.

---

### Task A3.2: Daemon — source_machine_id in the observation store + POST /observations passthrough (Option B)
**Week:** 1 · **Size:** M · **Depends on:** A3 (gate answered: Option B)
**User story:** As Spencer, I want the main's observation store to record which machine each observation came from, so that a main receiving capture from several nodes can tell the streams apart and filter recall by machine.
**Why (evidence):** G6: "There is no sourceMachineId in src/, mac/, or test/." `src/observation-store.js:66-98` creates `activity`/`frames`/`texts` with no machine column, and the `POST /observations` handler (`src/hosted-interface.js:408-417`) calls `runtime.observations.record(observations)` with no batch metadata.

**Acceptance criteria:**
- `node --test test/observation-machine.test.js` passes (4 tests).
- `npm test` passes from `/Users/you/Dev/openAGI`.
- Opening a database created with the pre-change schema does not throw and gains `source_machine_id` columns on `activity` and `frames` (covered by the migration test).
- `POST /observations` with body `{"sourceMachineId":"...","observations":[...]}` stores the id (covered by the endpoint test).

**Files:**
- Create: test/observation-machine.test.js
- Modify: src/observation-store.js:56 (init), :101 (record), :148 (search)
- Modify: src/hosted-interface.js:408 (POST /observations handler)

**Interfaces:**
- Consumes: `new ObservationStore({ dir })` (src/observation-store.js:46); `createDurableRuntime(options)` / `createHostedInterface(runtime, { host, port })` from `src/index.js` (test-boot pattern copied from test/outreach-endpoints.test.js:9-17); node:sqlite `DatabaseSync`, `StatementSync.run(...)` returning `{ changes, lastInsertRowid }`.
- Produces (later tasks rely on these):
  - `ObservationStore.record(observations, meta = {})` — `meta.sourceMachineId: string|null` applies to every row lacking its own `o.sourceMachineId`. Backward compatible: all existing callers (`src/hosted-interface.js:412`, `src/integrations/buildbetter-tasks.js:314`) pass one arg and keep working.
  - `ObservationStore.search({ query, since, until, app, machine, limit })` — new optional `machine` filters rows to `source_machine_id === machine`. Legacy rows (NULL machine id) are excluded when `machine` is given.
  - Note for A3.4: the FTS5 `texts` table cannot be ALTERed, so machine filtering on the query path joins `texts.ref` back to `frames.frame_uid` (kind `frame`) and to `activity.id` (kind `activity`); `record()` now writes the activity rowid as the activity text ref (was `app:window`, used nowhere else — verified: `getRecentContext` joins refs only for `kind='frame'`, `existsRef` only checks `kind='transcript'`). Transcript rows are never machine-filtered (they are server-side syncs, not machine capture).

1. [ ] Write the failing test file `test/observation-machine.test.js` with exactly this content:
```js
// test/observation-machine.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ObservationStore } from "../src/observation-store.js";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

// These tests exercise the SQLite path (columns, FTS joins); skip cleanly on
// a Node without node:sqlite (< 22.5), matching the store's own fallback.
let hasSqlite = true;
try { await import("node:sqlite"); } catch { hasSqlite = false; }

test("record() stores a batch sourceMachineId and search({machine}) filters recent activity", { skip: !hasSqlite }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-mach-"));
  const store = new ObservationStore({ dir });
  await store.record([
    { kind: "activity", at: "2026-07-01T10:00:00.000Z", app: "Safari", window: "Docs", event: "focus" }
  ], { sourceMachineId: "mac-A" });
  await store.record([
    { kind: "activity", at: "2026-07-01T11:00:00.000Z", app: "Terminal", window: "htop", event: "focus" }
  ], { sourceMachineId: "mac-B" });

  const a = await store.search({ machine: "mac-A", limit: 10 });
  assert.equal(a.length, 1);
  assert.equal(a[0].app, "Safari");
  assert.equal(a[0].sourceMachineId, "mac-A");

  const none = await store.search({ machine: "mac-C", limit: 10 });
  assert.equal(none.length, 0);

  const all = await store.search({ limit: 10 });
  assert.equal(all.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("search({query, machine}) filters FTS hits (frames and activity) by machine", { skip: !hasSqlite }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-fts-"));
  const store = new ObservationStore({ dir });
  await store.record([
    { kind: "frame", at: "2026-07-01T10:00:00.000Z", app: "Safari", window: "Roadmap", frameId: "f-A", ocrText: "quarterly roadmap review" },
    { kind: "activity", at: "2026-07-01T10:00:01.000Z", app: "Safari", window: "quarterly roadmap tab", event: "focus" }
  ], { sourceMachineId: "mac-A" });
  await store.record([
    { kind: "frame", at: "2026-07-01T11:00:00.000Z", app: "Safari", window: "Roadmap", frameId: "f-B", ocrText: "quarterly roadmap review" }
  ], { sourceMachineId: "mac-B" });

  const hits = await store.search({ query: "roadmap", machine: "mac-A", limit: 10 });
  assert.equal(hits.length, 2);
  assert.ok(hits.every((h) => h.kind === "frame" ? h.ref === "f-A" : h.kind === "activity"));

  const unfiltered = await store.search({ query: "roadmap", limit: 10 });
  assert.equal(unfiltered.length, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("opening a pre-migration DB adds source_machine_id columns without losing rows", { skip: !hasSqlite }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-mig-"));
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(dir, "index.db"));
  db.exec(`
    CREATE TABLE activity (id INTEGER PRIMARY KEY, at TEXT NOT NULL, app TEXT, window TEXT, event TEXT, metadata TEXT);
    CREATE TABLE frames (id INTEGER PRIMARY KEY, frame_uid TEXT UNIQUE, captured_at TEXT NOT NULL, app TEXT, window TEXT, thumbnail_path TEXT, confidence REAL);
    CREATE VIRTUAL TABLE texts USING fts5(kind UNINDEXED, ref UNINDEXED, at UNINDEXED, app, window, text, tokenize='porter unicode61');
  `);
  db.exec(`INSERT INTO activity (at, app, window, event) VALUES ('2026-06-30T09:00:00.000Z', 'Xcode', 'legacy row', 'focus')`);
  db.close();

  const store = new ObservationStore({ dir });
  await store.record(
    { kind: "activity", at: "2026-07-01T09:00:00.000Z", app: "Safari", window: "new row", event: "focus" },
    { sourceMachineId: "mac-A" }
  );
  const filtered = await store.search({ machine: "mac-A", limit: 10 });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].window, "new row");
  const all = await store.search({ limit: 10 });
  assert.equal(all.length, 2, "legacy row must survive the migration");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("POST /observations passes the envelope sourceMachineId through to the store", { skip: !hasSqlite }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-ep-"));
  process.env.OPENAGI_AUTH_TOKEN = ""; // local, no auth for the test
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0 });
  const listened = await app.listen();
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  const res = await fetch(`${base}/observations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourceMachineId: "mac-A",
      observations: [{ kind: "activity", at: "2026-07-01T10:00:00.000Z", app: "Safari", window: "Docs", event: "focus" }]
    })
  });
  assert.equal(res.status, 200);
  const filtered = await runtime.observations.search({ machine: "mac-A", limit: 10 });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].sourceMachineId, "mac-A");
  await app.close?.();
});
```
2. [ ] Run it: `node --test test/observation-machine.test.js`. Expected: all 4 tests FAIL (the `machine` option is currently ignored, so filtered searches return every row, and no `sourceMachineId` field is returned). Each test fails at its first bad assertion: `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 2 !== 1` (tests 1 and 3), `3 !== 2` (test 2), and `undefined !== 'mac-A'` (test 4). If instead tests are skipped, the runner lacks node:sqlite — stop and report, do not fake a pass.
3. [ ] In `src/observation-store.js`, add the migration. Before (current code, end of `init()`, lines 89–99):
```js
      CREATE VIRTUAL TABLE IF NOT EXISTS texts USING fts5(
        kind UNINDEXED,
        ref UNINDEXED,
        at UNINDEXED,
        app,
        window,
        text,
        tokenize='porter unicode61'
      );
    `);
  }
```
After:
```js
      CREATE VIRTUAL TABLE IF NOT EXISTS texts USING fts5(
        kind UNINDEXED,
        ref UNINDEXED,
        at UNINDEXED,
        app,
        window,
        text,
        tokenize='porter unicode61'
      );
    `);
    this.migrate();
  }

  // Additive schema migration for DBs created before source_machine_id
  // existed (including the live multi-hundred-MB install). ALTER TABLE ADD
  // COLUMN is metadata-only in SQLite, so this is cheap; the PRAGMA guard
  // makes re-opening a no-op. The FTS5 texts table cannot be ALTERed —
  // machine filtering joins refs back to activity/frames instead (search()).
  migrate() {
    for (const table of ["activity", "frames"]) {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      if (!cols.includes("source_machine_id")) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN source_machine_id TEXT`);
      }
    }
  }
```
4. [ ] Replace `record()` in full. Before (current code, lines 101–146) — the entire existing `async record(observations) { ... }` method. After:
```js
  async record(observations, meta = {}) {
    await this.ready;
    if (!Array.isArray(observations)) observations = [observations];
    const batchMachineId = (typeof meta.sourceMachineId === "string" && meta.sourceMachineId) ? meta.sourceMachineId : null;
    if (this.fallback) {
      const lines = observations.map((o) => JSON.stringify({ ...o, sourceMachineId: o.sourceMachineId ?? batchMachineId, ingestedAt: nowIso() }) + "\n").join("");
      fs.appendFileSync(this.fallbackPath, lines);
      return { count: observations.length, mode: "fallback-jsonl" };
    }

    const insertActivity = this.db.prepare(
      `INSERT INTO activity (at, app, window, event, metadata, source_machine_id) VALUES (?, ?, ?, ?, ?, ?)`
    );
    const insertFrame = this.db.prepare(
      `INSERT OR IGNORE INTO frames (frame_uid, captured_at, app, window, thumbnail_path, confidence, source_machine_id) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const insertText = this.db.prepare(
      `INSERT INTO texts (kind, ref, at, app, window, text) VALUES (?, ?, ?, ?, ?, ?)`
    );

    let count = 0;
    this.db.exec("BEGIN");
    try {
      for (const o of observations) {
        if (!o || !o.kind) continue;
        const machineId = (typeof o.sourceMachineId === "string" && o.sourceMachineId) ? o.sourceMachineId : batchMachineId;
        if (o.kind === "activity") {
          const inserted = insertActivity.run(o.at ?? nowIso(), o.app ?? null, o.window ?? null, o.event ?? "focus", o.metadata ? JSON.stringify(o.metadata) : null, machineId);
          // ref = the activity rowid so machine-filtered search can join the
          // FTS row back to activity (texts itself can't carry the column).
          // Pre-migration activity text rows keep their old app:window refs;
          // they have no machine id, so machine filters correctly skip them.
          if (o.window) insertText.run("activity", String(inserted.lastInsertRowid), o.at ?? nowIso(), o.app ?? "", o.window ?? "", o.window);
        } else if (o.kind === "frame" || o.kind === "frame-summary") {
          const uid = o.frameId ? String(o.frameId) : createId("frm");
          insertFrame.run(uid, o.at ?? nowIso(), o.app ?? null, o.window ?? null, o.thumbnail ?? null, typeof o.confidence === "number" ? o.confidence : null, machineId);
          if (o.ocrText) insertText.run("frame", uid, o.at ?? nowIso(), o.app ?? "", o.window ?? "", o.ocrText);
        } else if (o.kind === "transcript") {
          // Long-form text (e.g. a BuildBetter call transcript) recorded so it's
          // searchable via the same FTS path as OCR/activity (and thus recall_activity).
          const ref = o.ref ? String(o.ref) : createId("txt");
          if (o.text) insertText.run("transcript", ref, o.at ?? nowIso(), o.app ?? "", o.window ?? "", o.text);
        }
        count += 1;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { count, mode: "sqlite" };
  }
```
5. [ ] Replace `search()` in full. Before (current code, lines 148–192) — the entire existing `async search({ query, since, until, app, limit = 25 } = {}) { ... }` method. After:
```js
  async search({ query, since, until, app, machine, limit = 25 } = {}) {
    await this.ready;
    if (this.fallback) {
      // Naive fallback search through the JSONL log.
      let rows = [];
      try { rows = fs.readFileSync(this.fallbackPath, "utf8").split("\n").filter(Boolean).map(JSON.parse); } catch { return []; }
      let out = rows;
      if (query) {
        const q = query.toLowerCase();
        out = out.filter((o) => (o.ocrText || "").toLowerCase().includes(q) || (o.window || "").toLowerCase().includes(q) || (o.text || "").toLowerCase().includes(q));
      }
      if (app) out = out.filter((o) => o.app === app);
      if (machine) out = out.filter((o) => o.sourceMachineId === machine);
      if (since) out = out.filter((o) => (o.at ?? "") >= since);
      if (until) out = out.filter((o) => (o.at ?? "") <= until);
      return out.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "")).slice(0, limit).map(capTranscriptText);
    }

    if (query) {
      // FTS5 query — escape doubled-quotes for the MATCH expression
      const escaped = String(query).replace(/"/g, '""');
      const matchExpr = `"${escaped}"`;
      // Machine filter: texts (FTS5) can't carry source_machine_id, so join
      // refs back to the base tables. Transcript rows and pre-migration rows
      // (NULL machine id / legacy activity refs) are excluded by design when
      // a machine filter is given.
      const machineClause = machine
        ? `AND ((kind = 'frame' AND ref IN (SELECT frame_uid FROM frames WHERE source_machine_id = ?))
            OR (kind = 'activity' AND ref IN (SELECT CAST(id AS TEXT) FROM activity WHERE source_machine_id = ?)))`
        : "";
      const rows = this.db.prepare(
        `SELECT kind, ref, at, app, window, snippet(texts, 5, '<mark>', '</mark>', '…', 16) AS snippet, text
         FROM texts WHERE texts MATCH ?
         ${app ? "AND app = ?" : ""}
         ${since ? "AND at >= ?" : ""}
         ${until ? "AND at <= ?" : ""}
         ${machineClause}
         ORDER BY at DESC LIMIT ?`
      );
      const params = [matchExpr];
      if (app) params.push(app);
      if (since) params.push(since);
      if (until) params.push(until);
      if (machine) { params.push(machine); params.push(machine); }
      params.push(limit);
      return rows.all(...params).map(capTranscriptText);
    }
    // No query → return recent activity by default.
    const params = [];
    let where = "1=1";
    if (app) { where += " AND app = ?"; params.push(app); }
    if (since) { where += " AND at >= ?"; params.push(since); }
    if (until) { where += " AND at <= ?"; params.push(until); }
    if (machine) { where += " AND source_machine_id = ?"; params.push(machine); }
    params.push(limit);
    return this.db.prepare(`SELECT 'activity' AS kind, app, window, at, event, source_machine_id AS sourceMachineId FROM activity WHERE ${where} ORDER BY at DESC LIMIT ?`).all(...params);
  }
```
6. [ ] In `src/hosted-interface.js`, pass the envelope id through. Before (current code, lines 408–417):
```js
      if (method === "POST" && pathname === "/observations") {
        const body = await readJson(req);
        const observations = Array.isArray(body) ? body : (Array.isArray(body.observations) ? body.observations : [body]);
        try {
          const result = await runtime.observations.record(observations);
          return sendJson(res, 200, result);
        } catch (error) {
          return sendJson(res, 500, { error: error.message });
        }
      }
```
After:
```js
      if (method === "POST" && pathname === "/observations") {
        const body = await readJson(req);
        const observations = Array.isArray(body) ? body : (Array.isArray(body.observations) ? body.observations : [body]);
        const sourceMachineId = (!Array.isArray(body) && typeof body.sourceMachineId === "string" && body.sourceMachineId) ? body.sourceMachineId : null;
        try {
          const result = await runtime.observations.record(observations, { sourceMachineId });
          return sendJson(res, 200, result);
        } catch (error) {
          return sendJson(res, 500, { error: error.message });
        }
      }
```
7. [ ] Run `node --test test/observation-machine.test.js`. Expected: `# pass 4`, `# fail 0`.
8. [ ] Run the full suite: `npm test` from `/Users/you/Dev/openAGI`. Expected: exit 0, no failures (watch `test/observation-transcript.test.js` and `test/buildbetter-transcripts.test.js` in particular — they share this store and must stay green).
9. [ ] Commit: `git add src/observation-store.js src/hosted-interface.js test/observation-machine.test.js && git commit -m "feat(observations): source_machine_id column, batch passthrough, machine-filtered search"` then `git push`.

---

### Task A3.3: Mac capture — stamp a persistent sourceMachineId on every batch (Option B)
**Week:** 1 · **Size:** S · **Depends on:** A3.1 (same files), A3.2 (daemon stores the id)
**User story:** As Spencer, I want every observation batch this Mac pushes to carry a stable machine id, so that the main can attribute capture to the right device once more than one node streams to it.
**Why (evidence):** G6: "There is no sourceMachineId in src/, mac/, or test/." The batch envelope built at `mac/Sources/OpenAGI/Capture/CaptureBridge.swift:51` is `["observations": payload]` with no origin field.

**Acceptance criteria:**
- `swift build --package-path /Users/you/Dev/openAGI/mac` prints `Build complete!`.
- After launching the packaged app once, `defaults read app.openagi.daemon sourceMachineId` prints a UUID, and it is identical across relaunches.
- On the receiving daemon, the count `SELECT COUNT(*) FROM activity WHERE source_machine_id IS NOT NULL` rises after the app pushes a batch (counts only — never read row content from the live store).

**Files:**
- Modify: mac/Sources/OpenAGI/AppState.swift (below `setCaptureMain`, added in A3.1)
- Modify: mac/Sources/OpenAGI/Capture/CaptureBridge.swift:51 (envelope)
- Modify: mac/Sources/OpenAGI/AppDelegate.swift:25 (first-launch creation)
- Test: none (no Swift test harness — build + manual verification below)

**Interfaces:**
- Consumes: `AppState.setCaptureMain(url:token:)` block from A3.1; envelope construction `let envelope: [String: Any] = ["observations": payload]` (CaptureBridge.swift:51); daemon-side `record(observations, { sourceMachineId })` from A3.2.
- Produces: `AppState.sourceMachineId() -> String` (nonisolated static; UserDefaults key `sourceMachineId`, UUID created on first call and persisted). Batch POST body shape becomes `{"observations":[...],"sourceMachineId":"<uuid>"}`.

1. [ ] In `mac/Sources/OpenAGI/AppState.swift`, directly after the `setCaptureMain` function added in A3.1, insert:
```swift
  // Stable per-install machine id stamped on every observation batch so a
  // main receiving capture from several nodes can tell the streams apart.
  // Created once (first launch / first flush) and persisted in UserDefaults.
  // nonisolated + UserDefaults (thread-safe) so CaptureBridge can call it
  // off the main actor.
  nonisolated static func sourceMachineId() -> String {
    let key = "sourceMachineId"
    if let existing = UserDefaults.standard.string(forKey: key), !existing.isEmpty { return existing }
    let fresh = UUID().uuidString
    UserDefaults.standard.set(fresh, forKey: key)
    return fresh
  }
```
2. [ ] In `mac/Sources/OpenAGI/AppDelegate.swift`, create the id on first launch. Before (current code, line 25):
```swift
      LoginItem.registerOnFirstLaunchIfNeeded()
```
After:
```swift
      LoginItem.registerOnFirstLaunchIfNeeded()
      // Mint the persistent capture machine id on first launch so the very
      // first pushed batch already carries it.
      _ = AppState.sourceMachineId()
```
3. [ ] In `mac/Sources/OpenAGI/Capture/CaptureBridge.swift`, stamp the envelope. Before (current code, line 51):
```swift
    let envelope: [String: Any] = ["observations": payload]
```
After:
```swift
    let envelope: [String: Any] = [
      "observations": payload,
      "sourceMachineId": AppState.sourceMachineId()
    ]
```
4. [ ] Build: `swift build --package-path /Users/you/Dev/openAGI/mac`. Expected: `Build complete!`, exit 0.
5. [ ] Manual verification (with Spencer; requires the A3.2 daemon code running on whichever daemon receives capture — for the remote Distiller main that means Spencer pulls this branch there and restarts its daemon first):
   - a. Rebuild and relaunch the packaged app (`./scripts/build-mac-app.sh`, Spencer quits the old app and opens `build/OpenAGI.app`).
   - b. `defaults read app.openagi.daemon sourceMachineId` → prints one UUID. Relaunch the app, re-run → the SAME UUID.
   - c. On the receiving daemon's machine, count stamped rows (read-only, counts only): `sqlite3 "file:$HOME/.openagi/observations/index.db?mode=ro" "SELECT COUNT(*) FROM activity WHERE source_machine_id IS NOT NULL"` → note the number, wait ~60s of Mac use, re-run → the number rises. Never SELECT row content from this live database.
6. [ ] Commit: `git add mac/Sources/OpenAGI/AppState.swift mac/Sources/OpenAGI/AppDelegate.swift mac/Sources/OpenAGI/Capture/CaptureBridge.swift && git commit -m "feat(mac/capture): stamp persistent sourceMachineId on every observation batch"` then `git push`.

---

### Task A3.4: recall_activity machine filter + machine param on GET /observations/search (Option B)
**Week:** 1 · **Size:** S · **Depends on:** A3.2
**User story:** As Spencer, I want to ask the agent "what was I doing on my laptop" versus "on the studio Mac", so that recall over ambient capture distinguishes devices once several nodes stream to one main.
**Why (evidence):** G6 remediation follow-through: after A3.2 the store can filter by machine, but the agent-facing `recall_activity` tool (`src/tool-registry.js:371-397`) and the dashboard search endpoint (`src/hosted-interface.js:418-426`) expose no machine parameter, so the new column is unreachable from chat.

**Acceptance criteria:**
- `node --test test/recall-activity-machine.test.js` passes (2 tests).
- `npm test` passes from `/Users/you/Dev/openAGI`.
- `GET /observations/search?machine=<id>` returns only rows recorded with that machine id.

**Files:**
- Create: test/recall-activity-machine.test.js
- Modify: src/tool-registry.js:371 (recall_activity registration)
- Modify: src/hosted-interface.js:418 (GET /observations/search)

**Interfaces:**
- Consumes: `ObservationStore.search({ query, since, until, app, machine, limit })` from A3.2; `ToolRegistry.invoke(name, args, context)` returning `{ ok, result }` (src/tool-registry.js:118); sparse-runtime test pattern `registerCoreTools(registry, { observations: store })` (mirrors test/recall-spend.test.js:16-17).
- Produces: `recall_activity` gains optional string param `machine`; handler forwards `machine: args.machine ?? null`. `GET /observations/search` gains query param `machine`.

1. [ ] Write the failing test file `test/recall-activity-machine.test.js` with exactly this content:
```js
// test/recall-activity-machine.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolRegistry, registerCoreTools } from "../src/tool-registry.js";
import { ObservationStore } from "../src/observation-store.js";

let hasSqlite = true;
try { await import("node:sqlite"); } catch { hasSqlite = false; }

async function seededStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recall-mach-"));
  const store = new ObservationStore({ dir });
  await store.record([
    { kind: "activity", at: "2026-07-01T10:00:00.000Z", app: "Safari", window: "Docs", event: "focus" }
  ], { sourceMachineId: "mac-A" });
  await store.record([
    { kind: "activity", at: "2026-07-01T11:00:00.000Z", app: "Terminal", window: "htop", event: "focus" }
  ], { sourceMachineId: "mac-B" });
  return { dir, store };
}

test("recall_activity forwards the machine filter to the observation store", { skip: !hasSqlite }, async () => {
  const { dir, store } = await seededStore();
  const registry = new ToolRegistry();
  registerCoreTools(registry, { observations: store });
  const { ok, result } = await registry.invoke("recall_activity", { machine: "mac-A", limit: 10 });
  assert.equal(ok, true);
  assert.equal(result.count, 1);
  assert.equal(result.results[0].app, "Safari");
  const schema = registry.get("recall_activity").parameters;
  assert.ok(schema.properties.machine, "machine must be an advertised parameter");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("recall_activity without machine returns rows from all machines", { skip: !hasSqlite }, async () => {
  const { dir, store } = await seededStore();
  const registry = new ToolRegistry();
  registerCoreTools(registry, { observations: store });
  const { ok, result } = await registry.invoke("recall_activity", { limit: 10 });
  assert.equal(ok, true);
  assert.equal(result.count, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
```
2. [ ] Run it: `node --test test/recall-activity-machine.test.js`. Expected: test 1 FAILS with `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 2 !== 1` (the handler currently drops `args.machine`); test 2 passes.
3. [ ] In `src/tool-registry.js`, extend the tool. Before (current code, the two spots inside the `recall_activity` registration, lines 381–382 and 386–396):
```js
        app: { type: "string", description: "Filter to a specific app (e.g. 'com.apple.Safari' or 'Linear')." },
        limit: { type: "integer", minimum: 1, maximum: 200 }
```
After:
```js
        app: { type: "string", description: "Filter to a specific app (e.g. 'com.apple.Safari' or 'Linear')." },
        machine: { type: "string", description: "Filter to observations captured on one machine (its sourceMachineId). Omit to search every machine." },
        limit: { type: "integer", minimum: 1, maximum: 200 }
```
And before (current code, lines 386–396):
```js
    handler: async (args) => {
      if (!runtime.observations) return { error: "no observation store" };
      const results = await runtime.observations.search({
        query: args.query ?? null,
        since: args.since ?? null,
        until: args.until ?? null,
        app: args.app ?? null,
        limit: args.limit ?? 25
      });
      return { count: results.length, results };
    }
```
After:
```js
    handler: async (args) => {
      if (!runtime.observations) return { error: "no observation store" };
      const results = await runtime.observations.search({
        query: args.query ?? null,
        since: args.since ?? null,
        until: args.until ?? null,
        app: args.app ?? null,
        machine: args.machine ?? null,
        limit: args.limit ?? 25
      });
      return { count: results.length, results };
    }
```
4. [ ] In `src/hosted-interface.js`, extend the search endpoint. Before (current code, lines 418–426):
```js
      if (method === "GET" && pathname === "/observations/search") {
        const query = url.searchParams.get("q") ?? null;
        const since = url.searchParams.get("since") ?? null;
        const until = url.searchParams.get("until") ?? null;
        const app = url.searchParams.get("app") ?? null;
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "25", 10);
        const results = await runtime.observations.search({ query, since, until, app, limit });
        return sendJson(res, 200, results);
      }
```
After:
```js
      if (method === "GET" && pathname === "/observations/search") {
        const query = url.searchParams.get("q") ?? null;
        const since = url.searchParams.get("since") ?? null;
        const until = url.searchParams.get("until") ?? null;
        const app = url.searchParams.get("app") ?? null;
        const machine = url.searchParams.get("machine") ?? null;
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "25", 10);
        const results = await runtime.observations.search({ query, since, until, app, machine, limit });
        return sendJson(res, 200, results);
      }
```
5. [ ] Run `node --test test/recall-activity-machine.test.js`. Expected: `# pass 2`, `# fail 0`.
6. [ ] Run the full suite: `npm test` from `/Users/you/Dev/openAGI`. Expected: exit 0, no failures.
7. [ ] Commit: `git add src/tool-registry.js src/hosted-interface.js test/recall-activity-machine.test.js && git commit -m "feat(tools): machine filter on recall_activity and the observations search endpoint"` then `git push`.
