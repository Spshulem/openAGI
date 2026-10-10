# Phase B: Make Feedback Mean Something (Week 2)

> **Read `00-INDEX.md` first** — its Global Constraints, decision gates, and execution protocol apply to every task below.
>
> **Drift rule:** Tasks in this plan share hot files (collision table in `00-INDEX.md`). If a Before-quote fails to match byte-for-byte and the difference is explained by an EARLIER task in this plan having edited that region (e.g. a new entry appended to `MAP` in `src/outreach-mapper.js`), apply the edit by intent — make the same change relative to the current code — and say so in the commit body. If the drift is NOT explained by an earlier plan task, STOP and report; the repo has moved since 2026-07-05.
>
> **Cross-task note (B2 after A1):** A1 already added a `skill-candidate` entry to `MAP` in `src/outreach-mapper.js`, `dedupeOpen` to `OutreachStore.append`, and `"skill"` to `digestTypes`. B2's Before-quotes of those regions predate A1 — apply by intent. B2 deliberately adds thumbs (`up`/`down`) only to draft and suggestion entries, NOT to skill items (those resolve via accept/dismiss); do not "fix" that.


---

<!-- verified:B1 status=fixed:5 -->
### Task B1: Outcome quality measures success, not activity

**Week:** 2 · **Size:** M · **Depends on:** none
**User story:** As Spencer (the openAGI owner), I want an outcome's quality score to reflect whether its tool calls actually succeeded, so that downstream learners (scrutiny fitter, specialist retirement, routing quality) train on "did this work" instead of "did it do anything".
**Why (evidence):** Gap G5 (confirmed): `resolveSweep` at src/outcome-store.js:167-177 scores any cron/autopilot fire with >=1 tool call a constant 0.7, ignoring the per-call `ok` flags that agent-host.js:181 already records — a run of all-failed tool calls still scores 0.7 (1023 of 2000 live resolved outcomes sit at exactly 0.70). src/skills.js:109 likewise resolves 0.7 on any skill completion even though the provider result's `toolCalls[].result.ok` data is available right there at line 110.

**Scope notes (read before executing):**
- Do NOT touch `src/skill-replay.js` — its line 115 is already graded (0.0 error / 0.5 dry-run / 0.9 success). Verify with `git diff --name-only` before each commit that it does not appear.
- src/skills.js DOES have per-call data (`result.toolCalls` with `c.result?.ok`, same provider shape agent-host.js:181 maps), so it is IN scope. Design decision for skills: a completion with ZERO tool calls keeps the historical 0.7 (a text-only skill run that returned output is a real completion, unlike a cron pulse that did nothing); only tool-using runs get graded by the helper. The thrown-error path (0.1 "skill-failed", skills.js:112) is unchanged.
- Resolution source strings stay exactly `"system-inferred"` and `"skill-completed"` — live dashboards and G5's analysis key on them.
- Never read file contents under `~/.openagi` — the live store holds personal data. Nothing in this task requires it; all tests use `fs.mkdtempSync` temp dirs.

**Acceptance criteria:**
- `node --test test/outcome-quality.test.js` exits 0 with 4 passing tests.
- `scoreFromToolCalls` is exported from both `src/outcome-store.js` and `src/index.js` (check: `node -e "import('./src/index.js').then(m => console.log(typeof m.scoreFromToolCalls))"` run from `/Users/you/Dev/openAGI` prints `function`).
- `resolveSweep` resolves a fresh `cron-fire`/`autopilot-fire` with: all calls ok → 0.7, some failed → 0.45, ALL failed → 0.1; a quiet fire older than 1h still → 0.5; unanswered `sent-message` still → 0.4; all with source `"system-inferred"` (verified by the new tests plus the pre-existing test at test/abi-runtime.test.js:386 still passing).
- A `SkillRegistry.run` whose provider result contains only failed tool calls resolves its outcome at 0.1 with source `"skill-completed"`; a tool-free completion still resolves 0.7 (verified by the new skills test).
- `git diff main -- src/skill-replay.js` is empty.
- `npm test` (full suite, run from `/Users/you/Dev/openAGI`) exits 0.

**Files:**
- Modify: src/outcome-store.js:144 (doc comment), src/outcome-store.js:167-177 (cron/autopilot branch), src/outcome-store.js:235 (append helper after class)
- Modify: src/index.js:30 (add export)
- Modify: src/skills.js:1-3 (add import), src/skills.js:107-110 (completion scoring)
- Test: test/outcome-quality.test.js (new)

**Interfaces:**
- Consumes (existing, copied from source):
  - `OutcomeStore` constructor: `constructor(options = {})` with `options.dir` (src/outcome-store.js:13)
  - `record(input)` → outcome object with fields `{ id, kind, toolCalls: input.toolCalls ?? [], at: input.at ?? nowIso(), resolved: false, qualityScore: null, source: null, ... }` (src/outcome-store.js:23-46)
  - `resolveSweep({ now = new Date(), agentStore = null, timeoutHours = 24, replyWindowHours = 6 } = {})` → array of `{ id, score, source }` (src/outcome-store.js:147)
  - `recent(limit = 50, kind = null)` (src/outcome-store.js:73)
  - Recorded toolCalls shape, from src/agent-host.js:181: `toolCalls: (modelResult.toolCalls ?? []).map((c) => ({ name: c.name, ok: c.result?.ok ?? false }))` — i.e. an array of `{ name: string, ok: boolean }`
  - Provider result shape consumed in src/skills.js:97-110: `result.toolCalls` is an array of `{ name, arguments, result: { ok: boolean, ... } }`
  - `SkillRegistry` constructor: `constructor(options = {})` with `options.runtime`, `options.dirs` (src/skills.js:6-11); `run(name, { input = "", args = {} } = {}, context = {})` (src/skills.js:68)
- Produces (new, later tasks may rely on):
  - `export function scoreFromToolCalls(toolCalls)` in src/outcome-store.js, re-exported from src/index.js. Input: array of `{ name, ok }` (or null/undefined). Returns a number: `0.5` (empty/absent), `0.7` (all ok), `0.45` (some failed), `0.1` (all failed). Pure, no I/O.

---

**Steps**

1. [ ] Create the test file with the pure-function table test and the two sweep tests (the skills test is added later in step 7). Write `/Users/you/Dev/openAGI/test/outcome-quality.test.js` with exactly this content:

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OutcomeStore, scoreFromToolCalls } from "../src/outcome-store.js";

test("scoreFromToolCalls grades runs by per-call ok flags", () => {
  // Table: [toolCalls, expected score]
  const cases = [
    [[], 0.5],
    [null, 0.5],
    [undefined, 0.5],
    [[{ name: "remember", ok: true }], 0.7],
    [[{ name: "remember", ok: true }, { name: "recall", ok: true }], 0.7],
    [[{ name: "remember", ok: true }, { name: "recall", ok: false }], 0.45],
    [[{ name: "remember", ok: false }], 0.1],
    [[{ name: "remember", ok: false }, { name: "recall", ok: false }], 0.1]
  ];
  for (const [calls, expected] of cases) {
    assert.equal(scoreFromToolCalls(calls), expected, `toolCalls=${JSON.stringify(calls)}`);
  }
});

test("resolveSweep grades cron/autopilot fires by tool-call results", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-outcome-quality-"));
  const store = new OutcomeStore({ dir });
  const allFailed = store.record({
    kind: "cron-fire",
    sessionId: "s1",
    toolCalls: [{ name: "web_search", ok: false }, { name: "remember", ok: false }]
  });
  const mixed = store.record({
    kind: "autopilot-fire",
    sessionId: "s2",
    toolCalls: [{ name: "web_search", ok: true }, { name: "remember", ok: false }]
  });
  const allOk = store.record({
    kind: "cron-fire",
    sessionId: "s3",
    toolCalls: [{ name: "remember", ok: true }]
  });

  const sweep = store.resolveSweep();
  assert.equal(sweep.length, 3);

  const byId = new Map(sweep.map((r) => [r.id, r]));
  assert.equal(byId.get(allFailed.id).score, 0.1, "all-failed fire scores 0.1");
  assert.equal(byId.get(mixed.id).score, 0.45, "mixed fire scores 0.45");
  assert.equal(byId.get(allOk.id).score, 0.7, "all-ok fire scores 0.7");

  for (const o of [allFailed, mixed, allOk]) {
    const resolved = store.recent(10).find((r) => r.id === o.id);
    assert.equal(resolved.resolved, true);
    assert.equal(resolved.source, "system-inferred", "resolution source string is unchanged");
  }
});

test("resolveSweep still scores a quiet old cron fire 0.5", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-outcome-quiet-"));
  const store = new OutcomeStore({ dir });
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const quiet = store.record({ kind: "cron-fire", sessionId: "s1", toolCalls: [], at: twoHoursAgo });

  const sweep = store.resolveSweep();
  assert.equal(sweep.length, 1);
  assert.equal(sweep[0].id, quiet.id);
  assert.equal(sweep[0].score, 0.5);
  assert.equal(sweep[0].source, "system-inferred");
});
```

2. [ ] Run the new test file and confirm it fails on the missing export:

```
cd /Users/you/Dev/openAGI && node --test test/outcome-quality.test.js
```

Expected failure: the file fails to load with `SyntaxError: The requested module '../src/outcome-store.js' does not provide an export named 'scoreFromToolCalls'` and the runner reports `# fail 1` (the whole file counts as one failure). Do not proceed until you see exactly this class of error.

3. [ ] Add the exported pure helper to `/Users/you/Dev/openAGI/src/outcome-store.js`. Insert it AFTER the closing brace of the `OutcomeStore` class and BEFORE `function clampScore(s) {`. The current code at that boundary (lines 235-237) reads exactly:

```js
}

function clampScore(s) {
```

Replace it with:

```js
}

/**
 * Grade a run by its recorded per-call ok flags — the shape agent-host
 * records: [{ name, ok }]. Pure so it is unit-testable.
 * - no tool calls -> 0.5 (nothing attempted; the "quiet" baseline)
 * - all calls ok  -> 0.7 (productive)
 * - some failed   -> 0.45 (partially productive)
 * - all failed    -> 0.1 (executed but nothing worked)
 */
export function scoreFromToolCalls(toolCalls) {
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  if (calls.length === 0) return 0.5;
  const failed = calls.filter((c) => !(c?.ok)).length;
  if (failed === 0) return 0.7;
  if (failed === calls.length) return 0.1;
  return 0.45;
}

function clampScore(s) {
```

4. [ ] Run the test file again:

```
cd /Users/you/Dev/openAGI && node --test test/outcome-quality.test.js
```

Expected: the pure-function test and the quiet-cron test pass; the sweep-grading test FAILS with `AssertionError [ERR_ASSERTION]` on `all-failed fire scores 0.1` showing `0.7 !== 0.1` (resolveSweep still hardcodes 0.7). Runner reports `# pass 2` / `# fail 1`.

5. [ ] Wire the helper into `resolveSweep` in `/Users/you/Dev/openAGI/src/outcome-store.js`. Two narrow edits.

Edit 5a — update the stale doc comment. Current line 144 reads exactly:

```js
   * - cron-fire / autopilot-fire with tool calls → 0.7 productive; 'standing by' → 0.5 quiet
```

Replace with:

```js
   * - cron-fire / autopilot-fire with tool calls → graded by per-call ok flags via scoreFromToolCalls (all ok 0.7, some failed 0.45, all failed 0.1); 'standing by' → 0.5 quiet
```

Edit 5b — replace the flat 0.7. The current code at lines 167-172 reads exactly:

```js
      if (score === null && (o.kind === "cron-fire" || o.kind === "autopilot-fire")) {
        if (Array.isArray(o.toolCalls) && o.toolCalls.length > 0) {
          score = 0.7;
          source = "system-inferred";
          note = `${o.toolCalls.length} tool call(s) executed`;
        } else if (age > 60 * 60 * 1000) {
```

Replace with:

```js
      if (score === null && (o.kind === "cron-fire" || o.kind === "autopilot-fire")) {
        if (Array.isArray(o.toolCalls) && o.toolCalls.length > 0) {
          const failedCalls = o.toolCalls.filter((c) => !(c?.ok)).length;
          score = scoreFromToolCalls(o.toolCalls);
          source = "system-inferred";
          note = `${o.toolCalls.length} tool call(s) executed, ${failedCalls} failed`;
        } else if (age > 60 * 60 * 1000) {
```

(No import is needed — `scoreFromToolCalls` is defined in this same file. The `sent-message` 0.4 branch, the quiet 0.5 branch, and the timeout branch are NOT touched.)

6. [ ] Re-export the helper from `/Users/you/Dev/openAGI/src/index.js`. Current line 30 reads exactly:

```js
export { OutcomeStore } from "./outcome-store.js";
```

Replace with:

```js
export { OutcomeStore, scoreFromToolCalls } from "./outcome-store.js";
```

Then run the test file and the full suite; both must pass:

```
cd /Users/you/Dev/openAGI && node --test test/outcome-quality.test.js
```

Expected: `# tests 3` … `# pass 3` … `# fail 0`.

```
cd /Users/you/Dev/openAGI && npm test
```

Expected: exit code 0, `# fail 0` (the pre-existing sweep test at test/abi-runtime.test.js:386 uses an all-ok tool call, which still scores 0.7, so it stays green).

Verify no accidental edits, then commit:

```
cd /Users/you/Dev/openAGI && git diff --name-only
```

Expected: `src/index.js` and `src/outcome-store.js` appear, and `src/skill-replay.js` does NOT. The new test file is untracked at this point, so it shows in `git status` but not in `git diff --name-only`. Note: the working tree has a pre-existing, unrelated deletion of `.buildbetter/manifest.json`, so that path may also appear — ignore it, and do NOT stage, commit, or restore it. Then:

```
cd /Users/you/Dev/openAGI && git add src/outcome-store.js src/index.js test/outcome-quality.test.js && git commit -m "feat(outcomes): grade sweep resolutions by per-call ok flags via scoreFromToolCalls" && git push
```

7. [ ] Add the skills test. Append the following to the END of `/Users/you/Dev/openAGI/test/outcome-quality.test.js` (after the last existing test), including the extra import: first change the existing import line at the top of the file. Current line 6 reads exactly:

```js
import { OutcomeStore, scoreFromToolCalls } from "../src/outcome-store.js";
```

Replace with:

```js
import { OutcomeStore, scoreFromToolCalls } from "../src/outcome-store.js";
import { SkillRegistry } from "../src/skills.js";
```

Then append this test at the end of the file:

```js
test("skill run grades completion by tool-call results; tool-free run keeps 0.7", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-skill-quality-"));
  const skillsRoot = path.join(root, "skills");
  const skillDir = path.join(skillsRoot, "demo");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: demo\ndescription: test skill\n---\nDo the thing: {{input}}\n"
  );

  const outcomes = new OutcomeStore({ dir: path.join(root, "outcomes") });
  // Mutable per-run provider response, in the shape provider.generate
  // returns (toolCalls carry result.ok, as agent-host.js maps at :181).
  let nextToolCalls = [
    { name: "web_search", arguments: {}, result: { ok: false } },
    { name: "remember", arguments: {}, result: { ok: false } }
  ];
  const runtime = {
    outcomes,
    agentHost: {
      modelProvider: {
        generate: async () => ({ text: "done", toolCalls: nextToolCalls })
      }
    }
  };
  const registry = new SkillRegistry({ runtime, dirs: [skillsRoot] });

  // All tool calls failed: completion resolves 0.1, not the old flat 0.7.
  const failedRun = await registry.run("demo", { input: "attempt one" });
  assert.equal(failedRun.output, "done");
  const failedOutcome = outcomes.recent(1)[0];
  assert.equal(failedOutcome.kind, "skill-run");
  assert.equal(failedOutcome.resolved, true);
  assert.equal(failedOutcome.qualityScore, 0.1);
  assert.equal(failedOutcome.source, "skill-completed", "source string is unchanged");

  // Tool-free completion keeps the historical 0.7. Look the outcome up
  // by its recorded input rather than recent(1)[0]: both runs can land
  // in the same millisecond, and recent() sorts by the ISO `at` string,
  // so a timestamp tie would make recent(1)[0] ambiguous.
  nextToolCalls = [];
  await registry.run("demo", { input: "attempt two" });
  const quietOutcome = outcomes.recent(10).find((o) => o.metadata.input === "attempt two");
  assert.equal(quietOutcome.qualityScore, 0.7);
  assert.equal(quietOutcome.source, "skill-completed");
});
```

8. [ ] Run the test file and confirm only the new skills test fails:

```
cd /Users/you/Dev/openAGI && node --test test/outcome-quality.test.js
```

Expected: `# pass 3` / `# fail 1`, with the failure in "skill run grades completion by tool-call results; tool-free run keeps 0.7" showing `AssertionError [ERR_ASSERTION]: 0.7 !== 0.1` (skills.js still resolves a flat 0.7).

9. [ ] Fix `/Users/you/Dev/openAGI/src/skills.js`. Two narrow edits.

Edit 9a — add the import. Current lines 1-3 read exactly:

```js
import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "./file-utils.js";
```

Replace with:

```js
import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "./file-utils.js";
import { scoreFromToolCalls } from "./outcome-store.js";
```

(No circular import: outcome-store.js imports only node:path, file-utils.js, utils.js, and data-dir.js.)

Edit 9b — grade the completion. The current code at lines 107-110 reads exactly:

```js
      // Successful skill run scores 0.7 by default. The resolveSweep
      // can downgrade later if user feedback is negative.
      if (outcome) this.runtime.outcomes.resolve(outcome.id, 0.7, "skill-completed");
      return { skill: skill.name, output: result.text, toolCalls: result.toolCalls ?? [] };
```

Replace with:

```js
      // Grade the completion by its tool-call results when the run used
      // tools (all ok 0.7, some failed 0.45, all failed 0.1). A tool-free
      // completion keeps the historical 0.7: the skill's whole job was to
      // produce text and it did. The resolveSweep can still downgrade
      // later if user feedback is negative.
      if (outcome) {
        const calls = (result.toolCalls ?? []).map((c) => ({ name: c.name, ok: c.result?.ok ?? false }));
        const completionScore = calls.length > 0 ? scoreFromToolCalls(calls) : 0.7;
        this.runtime.outcomes.resolve(outcome.id, completionScore, "skill-completed");
      }
      return { skill: skill.name, output: result.text, toolCalls: result.toolCalls ?? [] };
```

(The `catch` block at lines 111-114 with `resolve(outcome.id, 0.1, "skill-failed", ...)` is NOT touched.)

10. [ ] Run the test file, then the full suite:

```
cd /Users/you/Dev/openAGI && node --test test/outcome-quality.test.js
```

Expected: `# tests 4` … `# pass 4` … `# fail 0`.

```
cd /Users/you/Dev/openAGI && npm test
```

Expected: exit code 0, `# fail 0`.

11. [ ] Verify skill-replay.js is untouched, then commit and push:

```
cd /Users/you/Dev/openAGI && git diff --name-only
```

Expected: `src/skills.js` and `test/outcome-quality.test.js` appear (the test file is tracked after the step 6 commit, so its step 7 changes show here); `src/skill-replay.js` must NOT appear. As in step 6, the pre-existing `.buildbetter/manifest.json` deletion may also be listed — ignore it and do not stage it. Then:

```
cd /Users/you/Dev/openAGI && git add src/skills.js test/outcome-quality.test.js && git commit -m "fix(skills): grade skill completions by tool-call results instead of flat 0.7" && git push
```

**Explicitly out of scope for this task:** `src/skill-replay.js:115` (already graded 0.0/0.5/0.9 — verified, do not modify); any LLM-based usefulness judging (spec abi-completion.md:29 sanctions layering that later); the never-firing user-followup tone path (separate gap); backfilling or re-scoring existing live outcomes in `~/.openagi/outcomes` (historical 0.7 rows are left as-is).

---

<!-- verified:B2 status=fixed:1 -->
### Task B2.1: Revive the user-followup tone path — feedback resolves outcomes on the turn it arrives
**Week:** 2 · **Size:** M · **Depends on:** none
**User story:** As Spencer (the openAGI owner), I want my next message after an agent reply — and my reactions to proactive work — to actually score how that work went, so that the fitter, specialist retirement, and routing quality train on "did this help Spencer" instead of "did it execute tools".
**Why (evidence):** Gap G5: the tone path is fully wired (src/agent-host.js:208 stamps `metadata.outcomeId` on the assistant message; src/outcome-store.js:156-165 evaluates followup tone in `resolveSweep`) yet 0 of 2000 live outcomes ever resolved with source `user-followup`. Session-level reproduction (performed 2026-07-05 against real modules, temp data dir) proved the sweep's tone branch works when a followup lands in the same session, so the deadness is structural, and live counts (keys only, no content read) pinned three mechanisms. Diagnosed mechanism, as testable assertions:
  - **A1 (pull-only tone):** tone evaluation exists ONLY inside `resolveSweep` (src/outcome-store.js:156-165) and only for kind `agent-reply` — but the live install has no interactive chat sessions at all (`~/.openagi/agent-host/sessions/` contains exactly `autopilot_agent-pulse.json`, `autopilot_weekly-harsh-review.json`, `local_setup_main.json`; every live `agent-reply` outcome is a Jun 7-16 test-fixture session `local:test:main` / `sms:+15555550123:main`, all resolved `timeout`). Assertion: today, a user reply only resolves the prior outcome if a sweep runs while it is still pending; after the fix, the reply turn itself resolves it, no sweep needed.
  - **A2 (ordering/window bug — the dossier's leading hypothesis, confirmed for the kinds that matter):** 100% of real live work is `autopilot-fire` (492/492 resolved `system-inferred`), and `resolveSweep` (src/outcome-store.js:167-171) seals any fire with ≥1 tool call at a constant 0.7 on the FIRST ticker tick — the ticker runs every 10 s (src/hosted-interface.js:119 `tickerMs` default 10000, :1410 calls the sweep) — and `OutcomeStore.resolve` refuses already-resolved outcomes (src/outcome-store.js:50), so user feedback arriving minutes later can never register. Assertion: today `record({kind:"autopilot-fire", toolCalls:[…]})` + immediate `resolveSweep()` → resolved `system-inferred`; after the fix an immediate sweep leaves it pending and only a sweep past the followup window seals 0.7.
  - **A3 (the live feedback surface is disconnected):** the only user-input surface Spencer actually uses, `POST /outreach/:id/reply` (src/hosted-interface.js:693-702), forwards the user's reaction into a fresh one-shot session (`from: "outreach:<id>"`) with no link to the outcome that produced the item, so the tone path can never see it. (Fixed here for the store/agent side; the outreach linkage lands in B2.2 which adds `outcomeId` to items.)
**Acceptance criteria:**
- `node --test test/outcome-feedback.test.js` → 4 tests, `# fail 0`.
- The push path exists in code: `grep -n "resolveByUserFollowup" src/agent-host.js src/outcome-store.js` prints one call site in agent-host.js and one method definition in outcome-store.js.
- `node --test test/abi-runtime.test.js` shows no failures introduced by this task (the date-dependent task-store bucket test at test/abi-runtime.test.js:1595 already fails on unmodified main as of 2026-07-05 — verify with `git stash` if it fails, then `git stash pop`).
- `OPENAGI_DATA_DIR="$(mktemp -d)" npm test` → `# fail 3` or fewer, and the failing tests are only the pre-existing ones (test/abi-runtime.test.js:1595, test/credit-ledger.test.js:19, test/credit-ledger.test.js:79 — all date-window flakes verified failing on unmodified main on 2026-07-05). NEVER run bare `npm test` on this machine: parts of the suite construct runtimes on the default data dir, which is the owner's live `~/.openagi`.
**Files:**
- Modify: src/outcome-store.js:144 (sweep docstring line), src/outcome-store.js:147 (resolveSweep signature), src/outcome-store.js:167-171 (fire branch), src/outcome-store.js:210-218 (insert method after `feedback()`), src/outcome-store.js:247 (export inferToneScore)
- Modify: src/agent-host.js:64-75 (insert push-resolution after the sessionBefore block)
- Modify: test/abi-runtime.test.js:393-395 (sweep call gains a future `now`)
- Test: test/outcome-feedback.test.js (create)
**Interfaces:**
- Consumes: `record(input)` (src/outcome-store.js:23); `resolve(id, qualityScore, source = "system-inferred", note = null)` (src/outcome-store.js:48, returns `null` if unknown/already resolved); `pending(maxAgeMs = null)` (src/outcome-store.js:62, returns pending outcomes sorted oldest-first by `at`); `resolveSweep({ now = new Date(), agentStore = null, timeoutHours = 24, replyWindowHours = 6 } = {})` (src/outcome-store.js:147); `async handleMessage(input)` (src/agent-host.js:22); `function inferToneScore(text)` (src/outcome-store.js:247, returns 0.85 positive / 0.2 negative / 0.5 mixed / 0.6 neutral); `createDurableRuntime(options)` and `DeterministicModelProvider` (exported from src/index.js:1 and :42).
- Produces: `export function inferToneScore(text)` from src/outcome-store.js (B2.2 imports it); `OutcomeStore.resolveByUserFollowup(sessionId, text)` → resolved outcome or `null` (resolves the newest pending `agent-reply` outcome in that session at `inferToneScore(text)` with source `"user-followup"`); `resolveSweep` gains option `followupWindowMinutes = 30` (fires with tool calls are not system-inferred-resolved until older than this window).

Steps:

1. [ ] Create `test/outcome-feedback.test.js` with exactly this content:

```js
// test/outcome-feedback.test.js
// B2.1 regression: user feedback must actually resolve outcomes.
// Live evidence (2026-07-05): 0 of 2000 snapshot outcomes ever resolved with
// source "user-followup" — tone evaluation was pull-only (sweep) and the
// sweep sealed every cron/autopilot fire at 0.7 on the first 10s tick.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createDurableRuntime, DeterministicModelProvider, OutcomeStore } from "../src/index.js";

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("next user message in the same session resolves the prior turn as user-followup, not system-inferred", async () => {
  const runtime = createDurableRuntime({ dataDir: tmpDir("outcome-fb-"), modelProvider: new DeterministicModelProvider() });
  await runtime.agentHost.handleMessage({ channel: "local", from: "user", text: "what is on my calendar today?" });
  const pendingBefore = runtime.outcomes.pending().filter((o) => o.kind === "agent-reply");
  assert.equal(pendingBefore.length, 1, "turn 1 records one pending agent-reply outcome");
  const first = pendingBefore[0];

  // The user's reply IS the feedback. No sweep runs in this test on purpose:
  // the resolution must happen on the turn itself (push), not on the ticker.
  await runtime.agentHost.handleMessage({ channel: "local", from: "user", text: "thanks, perfect!" });

  const resolved = runtime.outcomes.recent(10).find((o) => o.id === first.id);
  assert.equal(resolved.resolved, true, "prior outcome resolves on the followup turn itself");
  assert.equal(resolved.source, "user-followup");
  assert.equal(resolved.qualityScore, 0.85);
});

test("negative followup tone scores low", async () => {
  const runtime = createDurableRuntime({ dataDir: tmpDir("outcome-fb-neg-"), modelProvider: new DeterministicModelProvider() });
  await runtime.agentHost.handleMessage({ channel: "local", from: "user", text: "draft a reply to the vendor" });
  const first = runtime.outcomes.pending().filter((o) => o.kind === "agent-reply")[0];
  await runtime.agentHost.handleMessage({ channel: "local", from: "user", text: "wrong, that is broken" });
  const resolved = runtime.outcomes.recent(10).find((o) => o.id === first.id);
  assert.equal(resolved.source, "user-followup");
  assert.equal(resolved.qualityScore, 0.2);
});

test("synthetic autopilot prompts do not count as user followups", async () => {
  const runtime = createDurableRuntime({ dataDir: tmpDir("outcome-fb-ap-"), modelProvider: new DeterministicModelProvider() });
  await runtime.agentHost.handleMessage({ channel: "autopilot", from: "autopilot", origin: "autopilot", sessionId: "autopilot:agent-pulse", text: "Pulse: anything to do?" });
  const first = runtime.outcomes.pending().find((o) => o.kind === "autopilot-fire");
  assert.ok(first, "autopilot turn records a pending autopilot-fire outcome");
  await runtime.agentHost.handleMessage({ channel: "autopilot", from: "autopilot", origin: "autopilot", sessionId: "autopilot:agent-pulse", text: "Pulse: anything to do?" });
  const after = runtime.outcomes.recent(10).find((o) => o.id === first.id);
  assert.notEqual(after.source, "user-followup", "autopilot prompts are synthetic, not user feedback");
});

test("resolveSweep holds fresh cron/autopilot fires open for the followup window", () => {
  const store = new OutcomeStore({ dir: tmpDir("sweep-window-") });
  const o = store.record({ kind: "autopilot-fire", sessionId: "autopilot:agent-pulse", toolCalls: [{ name: "list_tasks", ok: true }] });

  const early = store.resolveSweep(); // what the 10s ticker does right after the fire
  assert.equal(early.length, 0, "a fresh fire must stay pending so feedback can land first");
  assert.equal(store.outcomes.get(o.id).resolved, false);

  const late = store.resolveSweep({ now: new Date(Date.now() + 31 * 60 * 1000) });
  assert.equal(late.length, 1, "past the window the sweep still scores productivity");
  assert.equal(late[0].source, "system-inferred");
  assert.equal(store.outcomes.get(o.id).qualityScore, 0.7);
});
```

2. [ ] Run `node --test test/outcome-feedback.test.js`. Expect `# pass 1` / `# fail 3`: test 1 fails with AssertionError `prior outcome resolves on the followup turn itself` (actual `false`), test 2 fails with `null !== 'user-followup'`, test 4 fails with `a fresh fire must stay pending so feedback can land first` (actual `1`), and test 3 (autopilot guard) passes trivially. If the failure set differs, stop and re-read the diagnosis.

3. [ ] Edit `src/outcome-store.js` — export the tone scorer. Replace:

```js
function inferToneScore(text) {
```

with:

```js
export function inferToneScore(text) {
```

4. [ ] Edit `src/outcome-store.js` — add the push-path method. Replace:

```js
  /**
   * Explicit user feedback: rate a specific turn.
   */
  feedback(refId, qualityScore, note = null) {
    const outcomes = this.byRef(refId);
    if (outcomes.length === 0) return null;
    const target = outcomes[outcomes.length - 1]; // latest
    return this.resolve(target.id, qualityScore, "explicit-rating", note);
  }
```

with:

```js
  /**
   * Explicit user feedback: rate a specific turn.
   */
  feedback(refId, qualityScore, note = null) {
    const outcomes = this.byRef(refId);
    if (outcomes.length === 0) return null;
    const target = outcomes[outcomes.length - 1]; // latest
    return this.resolve(target.id, qualityScore, "explicit-rating", note);
  }

  /**
   * Push-path tone resolution: the next user message in a session resolves
   * the most recent pending agent-reply outcome for that session. Called by
   * agent-host on every real user turn so feedback lands immediately instead
   * of waiting for the periodic sweep (which live data showed never saw a
   * followup — 0 of 2000 outcomes ever resolved as user-followup).
   */
  resolveByUserFollowup(sessionId, text) {
    if (!sessionId) return null;
    const candidates = this.pending().filter((o) => o.kind === "agent-reply" && o.sessionId === sessionId);
    if (candidates.length === 0) return null;
    const target = candidates[candidates.length - 1]; // newest; pending() sorts oldest-first
    return this.resolve(target.id, inferToneScore(text), "user-followup", "tone of next user message");
  }
```

5. [ ] Edit `src/outcome-store.js` — add the followup window to the sweep. Three replacements. First, the docstring line; replace:

```js
   * - cron-fire / autopilot-fire with tool calls → 0.7 productive; 'standing by' → 0.5 quiet
```

with:

```js
   * - cron-fire / autopilot-fire with tool calls → 0.7 productive (only once
   *   older than followupWindowMinutes, so feedback can land first); 'standing by' → 0.5 quiet
```

Second, the signature; replace:

```js
  resolveSweep({ now = new Date(), agentStore = null, timeoutHours = 24, replyWindowHours = 6 } = {}) {
```

with:

```js
  resolveSweep({ now = new Date(), agentStore = null, timeoutHours = 24, replyWindowHours = 6, followupWindowMinutes = 30 } = {}) {
```

Third, the fire branch; replace:

```js
      if (score === null && (o.kind === "cron-fire" || o.kind === "autopilot-fire")) {
        if (Array.isArray(o.toolCalls) && o.toolCalls.length > 0) {
          score = 0.7;
          source = "system-inferred";
          note = `${o.toolCalls.length} tool call(s) executed`;
        } else if (age > 60 * 60 * 1000) {
```

with:

```js
      if (score === null && (o.kind === "cron-fire" || o.kind === "autopilot-fire")) {
        // Hold fresh fires open for a followup window so user feedback
        // (explicit thumbs, outreach-reply tone) can resolve them first.
        // Previously the first 10s ticker tick sealed every fire at 0.7
        // forever — resolve() refuses already-resolved outcomes, so late
        // feedback was silently dropped.
        if (Array.isArray(o.toolCalls) && o.toolCalls.length > 0 && age > followupWindowMinutes * 60 * 1000) {
          score = 0.7;
          source = "system-inferred";
          note = `${o.toolCalls.length} tool call(s) executed`;
        } else if (age > 60 * 60 * 1000) {
```

6. [ ] Edit `src/agent-host.js` — resolve the prior turn's outcome on every real user turn. Replace:

```js
    const sessionBefore = ephemeral
      ? { id: sessionId, messages: [{ role: "user", content: text }] }
      : this.store.appendMessage(sessionId, {
          role: "user",
          content: text,
          agentId,
          channel,
          from,
          metadata: input.metadata ?? {}
        });

    const signal = this.messageToSignal({ text, channel, from, agent, sessionId, metadata: input.metadata ?? {} });
```

with:

```js
    const sessionBefore = ephemeral
      ? { id: sessionId, messages: [{ role: "user", content: text }] }
      : this.store.appendMessage(sessionId, {
          role: "user",
          content: text,
          agentId,
          channel,
          from,
          metadata: input.metadata ?? {}
        });

    // Feedback loop: the user's next message in this conversation IS the
    // verdict on the previous reply. Resolve the prior turn's pending outcome
    // from its tone NOW (push), instead of hoping the periodic sweep sees it
    // before the 24h timeout. Autopilot/cron prompts are synthetic user-role
    // messages, not the human — they must never vote. Ephemeral turns leave
    // no trace, so they don't vote either.
    if (!ephemeral && channel !== "autopilot" && channel !== "cron") {
      try { this.runtime.outcomes?.resolveByUserFollowup?.(sessionId, text); } catch { /* best effort */ }
    }

    const signal = this.messageToSignal({ text, channel, from, agent, sessionId, metadata: input.metadata ?? {} });
```

7. [ ] Run `node --test test/outcome-feedback.test.js`. Expect `# pass 4` / `# fail 0`.

8. [ ] Edit `test/abi-runtime.test.js` — the existing sweep test records a cron-fire and sweeps immediately; with the followup window it must sweep from past the window. Replace:

```js
  first.resolve(a.id, 0.85, "user-followup");
  const sweep = first.resolveSweep();
  assert.ok(sweep.length >= 1, "cron-fire with tool calls should resolve via sweep");
```

with:

```js
  first.resolve(a.id, 0.85, "user-followup");
  // Sweep from 31 minutes in the future: fresh fires are held open for the
  // 30-minute followup window so user feedback can land first (B2.1).
  const sweep = first.resolveSweep({ now: new Date(Date.now() + 31 * 60 * 1000) });
  assert.ok(sweep.length >= 1, "cron-fire with tool calls should resolve via sweep");
```

9. [ ] Run `node --test test/abi-runtime.test.js`. Expect the "outcome store records, resolves, aggregates, and reloads" test to pass. The only acceptable failure is the pre-existing date-dependent one at test/abi-runtime.test.js:1595 ("task-store: month/quarter/year buckets..."), which fails on unmodified main as of 2026-07-05; if unsure whether a failure is pre-existing, `git stash`, re-run, compare, `git stash pop`.

10. [ ] Run the full suite scoped away from the live data dir: `OPENAGI_DATA_DIR="$(mktemp -d)" npm test`. Expect `# pass 352` / `# fail 3`, the 3 being the pre-existing date flakes listed in the acceptance criteria. Never run bare `npm test` (it writes test outcomes into the owner's live `~/.openagi` and evicts real rows from the 2000-item snapshot).

11. [ ] Commit: `git add src/outcome-store.js src/agent-host.js test/outcome-feedback.test.js test/abi-runtime.test.js && git commit -m "fix(outcomes): next user message resolves prior turn tone as user-followup; sweep holds fresh fires open for a followup window"` then `git push`.

### Task B2.2: Explicit thumbs — POST /outreach/:id/feedback resolves linked outcomes and teaches suggestion feedback
**Week:** 2 · **Size:** M · **Depends on:** B2.1
**User story:** As Spencer (the openAGI owner), I want one-tap thumbs up/down on every outreach item (drafts, suggestions — the digest types), so that a single tap becomes an `explicit-rating` outcome the learners can trust and a preference vote the proactive observer obeys.
**Why (evidence):** Gap G5: the live 2000-outcome snapshot has 0 `explicit-rating` resolutions; the outreach feed is the only surface Spencer actually uses (live `~/.openagi/agent-host/sessions/` has no interactive chat sessions), yet outreach items (src/outreach-store.js:23-43) carry only `sourceRef` — no reachable `outcomeId` — and no route accepts a verdict. `SuggestionFeedback` (src/suggestion-feedback.js:48-67) derives its accept/reject stats solely from `runtime.proactiveObserver.list()` statuses, so a thumbs verdict on a suggestion item must resolve the underlying suggestion (`ProactiveObserver.resolve(id, status, note)`, src/proactive-observer.js:326) to count. The Mac app posts every action button to `/act` (mac/Sources/OpenAGI/Outreach/OutreachConsumer.swift:124), so adding "up"/"down" to item `actions` plus an `/act` pass-through gives native thumbs buttons with zero client changes.
**Acceptance criteria:**
- `node --test test/outreach-mapper.test.js` → 6 tests, `# fail 0` (5 existing + 1 new).
- `node --test test/outreach-feedback.test.js` → 7 tests, `# fail 0`.
- `POST /outreach/:id/feedback` with `{"verdict":"down"}` on an item whose `outcomeId` points at a pending outcome returns 200, marks the item `acted` with `decision.action === "down"`, and resolves that outcome at 0.15 with source `explicit-rating`; `{"verdict":"up"}` scores 0.9. Verdicts other than up/down → 400. Unknown item → 404. Second POST on a resolved item → 200 with the original decision unchanged (mirrors `/act` idempotency at src/hosted-interface.js:678-680).
- An item with no linked outcome still records the verdict: a fresh `explicit-feedback` outcome with `refId === item.id` is recorded and immediately resolved at 0.9/0.15 `explicit-rating` (the signal is never dropped).
- A thumbs verdict on a `suggestion` item flips the underlying proactive suggestion to `accepted`/`rejected` (status only — materialization stays on POST /proactive/suggestions/:id/accept), which `SuggestionFeedback.computeStats()` then counts.
- Draft and suggestion items (the `digestTypes` per src/outreach-config.js:13) emitted by the mapper now include `"up"` and `"down"` in `actions`, and all mapped items pass through `outcomeId` when the source event carries one.
- `OPENAGI_DATA_DIR="$(mktemp -d)" npm test` → no new failures beyond the 3 pre-existing date flakes (B2.1 acceptance list).
**Files:**
- Modify: src/outreach-store.js:23-32 (append gains `outcomeId`)
- Modify: src/outreach-mapper.js:6-39 (MAP: outcomeId pass-through + thumbs actions on digest types)
- Modify: src/hosted-interface.js:16-17 (import inferToneScore), :688-692 (insert /feedback route after /act), :697-699 (/reply tone-resolves the linked outcome), :1497-1499 (applyOutreachAction routes up/down), :1529-1534 (insert applyOutreachFeedback helper before sendXml)
- Modify: test/outreach-mapper.test.js (append one test at end of file)
- Test: test/outreach-feedback.test.js (create)
**Interfaces:**
- Consumes: `OutreachStore.append({ type, sourceRef = null, title, summary = "", needsDecision = false, actions = [] })` (src/outreach-store.js:23); `OutreachStore.get(id)` (:45); `OutreachStore.resolve(id, decision, { status = "acted", error = null } = {})` (:66, no-ops with the existing item when already acted/dismissed); `ProactiveObserver.resolve(id, status, note = null)` (src/proactive-observer.js:326); `ProactiveObserver.list({ status = "pending" } = {})` (:315); `OutcomeStore.record(input)` / `resolve(id, qualityScore, source, note)` (src/outcome-store.js:23/:48); `export function inferToneScore(text)` (src/outcome-store.js, exported in B2.1); `applyOutreachAction(runtime, item, action, note)` (src/hosted-interface.js:1497); `app.__setChannels(c)` test seam (src/hosted-interface.js:1401); `sendJson(res, status, value)` and `readJson(req)` (src/hosted-interface.js).
- Produces: outreach item field `outcomeId: string | null` (persisted; older snapshot items simply lack it); `POST /outreach/:id/feedback` body `{ verdict: "up" | "down", note? }` → 200 `{ item }` / 400 / 404; module-private `async applyOutreachFeedback(runtime, item, verdict, note = null)` in src/hosted-interface.js (score 0.9 up / 0.15 down, source `"explicit-rating"`, falls back to recording a fresh `explicit-feedback` outcome, resolves suggestions in the observer store); `POST /outreach/:id/act` accepts `"up"`/`"down"`; mapper draft actions become `["approve","edit","dismiss","up","down"]`, suggestion actions become `["accept","dismiss","up","down"]`; new outcome kind `"explicit-feedback"`.

Steps:

1. [ ] Append this test to the end of `test/outreach-mapper.test.js` (after the "attach is idempotent" test, using the existing `harness()` helper at the top of that file):

```js
test("mapped items carry outcomeId and digest types offer thumbs actions", () => {
  const { events, store } = harness();
  events.emit("draft-created", { id: "draft_2", title: "With outcome", outcomeId: "out_123" });
  events.emit("proactive-suggestion", { id: "prop_2", title: "Suggests", category: "automation", rationale: "r" });
  const draft = store.list().find((i) => i.sourceRef?.id === "draft_2");
  const suggestion = store.list().find((i) => i.sourceRef?.id === "prop_2");
  assert.equal(draft.outcomeId, "out_123");
  assert.equal(suggestion.outcomeId, null);
  assert.ok(draft.actions.includes("up") && draft.actions.includes("down"));
  assert.ok(suggestion.actions.includes("up") && suggestion.actions.includes("down"));
});
```

2. [ ] Run `node --test test/outreach-mapper.test.js`. Expect `# pass 5` / `# fail 1`, the new test failing with AssertionError `undefined !== 'out_123'`.

3. [ ] Edit `src/outreach-store.js` — persist the linkage. Replace:

```js
  append({ type, sourceRef = null, title, summary = "", needsDecision = false, actions = [] }) {
    const item = {
      id: createId("out"),
      seq: this.nextSeq++,
      type,
      sourceRef,
```

with:

```js
  append({ type, sourceRef = null, title, summary = "", needsDecision = false, actions = [], outcomeId = null }) {
    const item = {
      id: createId("out"),
      seq: this.nextSeq++,
      type,
      sourceRef,
      outcomeId: outcomeId ?? null,
```

4. [ ] Edit `src/outreach-mapper.js` — pass `outcomeId` through and add thumbs to the digest types. Replace the whole MAP constant:

```js
const MAP = {
  "draft-created": (d) => ({
    type: "draft",
    sourceRef: { kind: "draft", id: d.id },
    title: d.title ?? "Draft ready",
    summary: (d.body ?? "").slice(0, 160),
    needsDecision: false,
    actions: ["approve", "edit", "dismiss"]
  }),
  "proactive-suggestion": (d) => ({
    type: "suggestion",
    sourceRef: { kind: "suggestion", id: d.id },
    title: d.title ?? "New suggestion",
    summary: d.rationale ?? "",
    needsDecision: false,
    actions: ["accept", "dismiss"]
  }),
  "pending-action": (d) => ({
    type: "pending-action",
    sourceRef: { kind: "pending-action", id: d.id },
    title: d.summary ?? "Action needs approval",
    summary: d.reason ?? "",
    needsDecision: true,
    actions: ["do", "dismiss"]
  }),
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

with:

```js
const MAP = {
  "draft-created": (d) => ({
    type: "draft",
    sourceRef: { kind: "draft", id: d.id },
    outcomeId: d.outcomeId ?? null,
    title: d.title ?? "Draft ready",
    summary: (d.body ?? "").slice(0, 160),
    needsDecision: false,
    // "up"/"down" are explicit thumbs: POST /outreach/:id/feedback (or /act)
    // resolves the linked outcome at 0.9/0.15 with source explicit-rating.
    actions: ["approve", "edit", "dismiss", "up", "down"]
  }),
  "proactive-suggestion": (d) => ({
    type: "suggestion",
    sourceRef: { kind: "suggestion", id: d.id },
    outcomeId: d.outcomeId ?? null,
    title: d.title ?? "New suggestion",
    summary: d.rationale ?? "",
    needsDecision: false,
    actions: ["accept", "dismiss", "up", "down"]
  }),
  "pending-action": (d) => ({
    type: "pending-action",
    sourceRef: { kind: "pending-action", id: d.id },
    outcomeId: d.outcomeId ?? null,
    title: d.summary ?? "Action needs approval",
    summary: d.reason ?? "",
    needsDecision: true,
    actions: ["do", "dismiss"]
  }),
  "clarification-created": (d) => ({
    type: "clarification",
    sourceRef: { kind: "clarification", id: d.id },
    outcomeId: d.outcomeId ?? null,
    title: d.question ?? "Quick question",
    summary: d.context ?? "",
    needsDecision: true,
    actions: ["yes", "no", "in_progress", "dropped"]
  })
};
```

5. [ ] Run `node --test test/outreach-mapper.test.js`. Expect `# pass 6` / `# fail 0`. Also run `node --test test/outreach-store.test.js test/outreach-endpoints.test.js test/outreach-digest.test.js` — expect all pass (the new append param is optional; existing callers are unaffected).

6. [ ] Commit: `git add src/outreach-store.js src/outreach-mapper.js test/outreach-mapper.test.js && git commit -m "feat(outreach): items carry outcomeId and digest types offer thumbs actions"` then `git push`.

7. [ ] Create `test/outreach-feedback.test.js` with exactly this content (style mirrors test/outreach-endpoints.test.js):

```js
// test/outreach-feedback.test.js
// B2.2: explicit thumbs on outreach items resolve linked outcomes at
// 0.9/0.15 with source explicit-rating, and teach SuggestionFeedback.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

async function bootApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "out-fb-"));
  process.env.OPENAGI_AUTH_TOKEN = ""; // local, no auth for the test
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0 });
  const listened = await app.listen();
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  return { runtime, app, base, dataDir };
}

function postJson(url, body) {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("POST /outreach/:id/feedback down resolves the linked outcome at 0.15 explicit-rating", async () => {
  const { runtime, app, base } = await bootApp();
  const outcome = runtime.outcomes.record({ kind: "autopilot-fire", toolCalls: [{ name: "save_draft", ok: true }] });
  const item = runtime.outreach.append({
    type: "draft", sourceRef: { kind: "draft", id: "draft_1" },
    title: "Reply to Acme", outcomeId: outcome.id,
    actions: ["approve", "edit", "dismiss", "up", "down"]
  });
  const res = await postJson(`${base}/outreach/${item.id}/feedback`, { verdict: "down" });
  assert.equal(res.status, 200);
  const resolved = runtime.outcomes.recent(10).find((o) => o.id === outcome.id);
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.qualityScore, 0.15);
  assert.equal(resolved.source, "explicit-rating");
  const updated = runtime.outreach.get(item.id);
  assert.equal(updated.status, "acted");
  assert.equal(updated.decision.action, "down");
  await app.close?.();
});

test("POST /outreach/:id/feedback up with no linked outcome records a fresh explicit-feedback outcome", async () => {
  const { runtime, app, base } = await bootApp();
  const item = runtime.outreach.append({ type: "draft", title: "Standalone draft" });
  const res = await postJson(`${base}/outreach/${item.id}/feedback`, { verdict: "up" });
  assert.equal(res.status, 200);
  const fresh = runtime.outcomes.recent(10).find((o) => o.kind === "explicit-feedback" && o.refId === item.id);
  assert.ok(fresh, "a fresh outcome must be recorded so the verdict is never dropped");
  assert.equal(fresh.resolved, true);
  assert.equal(fresh.qualityScore, 0.9);
  assert.equal(fresh.source, "explicit-rating");
  await app.close?.();
});

test("POST /outreach/:id/feedback rejects verdicts other than up/down", async () => {
  const { runtime, app, base } = await bootApp();
  const item = runtime.outreach.append({ type: "draft", title: "D" });
  const res = await postJson(`${base}/outreach/${item.id}/feedback`, { verdict: "meh" });
  assert.equal(res.status, 400);
  assert.equal(runtime.outreach.get(item.id).status, "unseen");
  await app.close?.();
});

test("POST /outreach/:id/feedback is idempotent after the item is resolved", async () => {
  const { runtime, app, base } = await bootApp();
  const item = runtime.outreach.append({ type: "draft", title: "Once" });
  await postJson(`${base}/outreach/${item.id}/feedback`, { verdict: "down" });
  const res2 = await postJson(`${base}/outreach/${item.id}/feedback`, { verdict: "up" });
  assert.equal(res2.status, 200);
  assert.equal(runtime.outreach.get(item.id).decision.action, "down");
  const feedbackOutcomes = runtime.outcomes.recent(10).filter((o) => o.kind === "explicit-feedback" && o.refId === item.id);
  assert.equal(feedbackOutcomes.length, 1, "second POST must not record another outcome");
  await app.close?.();
});

test("thumbs on a suggestion item teaches SuggestionFeedback via the observer store", async () => {
  const { runtime, app, base, dataDir } = await bootApp();
  const suggestDir = path.join(dataDir, "proactive", "suggestions");
  fs.mkdirSync(suggestDir, { recursive: true });
  fs.writeFileSync(path.join(suggestDir, "prop_fb1.json"), JSON.stringify({
    id: "prop_fb1", proposedAt: new Date().toISOString(), status: "pending",
    category: "automation", title: "Automate the weekly export"
  }));
  const item = runtime.outreach.append({
    type: "suggestion", sourceRef: { kind: "suggestion", id: "prop_fb1" },
    title: "Automate the weekly export", actions: ["accept", "dismiss", "up", "down"]
  });
  const res = await postJson(`${base}/outreach/${item.id}/feedback`, { verdict: "down" });
  assert.equal(res.status, 200);
  const rejected = runtime.proactiveObserver.list({ status: "rejected" });
  assert.ok(rejected.some((c) => c.id === "prop_fb1"), "thumbs-down must mark the suggestion rejected");
  await app.close?.();
});

test("POST /outreach/:id/act with action up routes to feedback (Mac app posts actions to /act)", async () => {
  const { runtime, app, base } = await bootApp();
  const outcome = runtime.outcomes.record({ kind: "autopilot-fire", toolCalls: [{ name: "save_draft", ok: true }] });
  const item = runtime.outreach.append({ type: "draft", title: "Via act", outcomeId: outcome.id });
  const res = await postJson(`${base}/outreach/${item.id}/act`, { action: "up" });
  assert.equal(res.status, 200);
  const resolved = runtime.outcomes.recent(10).find((o) => o.id === outcome.id);
  assert.equal(resolved.qualityScore, 0.9);
  assert.equal(resolved.source, "explicit-rating");
  assert.equal(runtime.outreach.get(item.id).status, "acted");
  await app.close?.();
});

test("POST /outreach/:id/reply tone-resolves the linked outcome as user-followup", async () => {
  const { runtime, app, base } = await bootApp();
  const outcome = runtime.outcomes.record({ kind: "autopilot-fire", toolCalls: [{ name: "save_draft", ok: true }] });
  const item = runtime.outreach.append({ type: "draft", title: "Draft ready", outcomeId: outcome.id });
  const fakeChannels = { handleLocalMessage: async () => ({ reply: "ok" }) };
  app.__setChannels(fakeChannels);
  const res = await postJson(`${base}/outreach/${item.id}/reply`, { text: "thanks, that was perfect" });
  assert.equal(res.status, 200);
  const resolved = runtime.outcomes.recent(10).find((o) => o.id === outcome.id);
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.source, "user-followup");
  assert.equal(resolved.qualityScore, 0.85);
  await app.close?.();
});
```

8. [ ] Run `node --test test/outreach-feedback.test.js`. Expect `# pass 0` / `# fail 7`: the four /feedback tests and the suggestion test fail with `404 !== 200` (route does not exist yet; the invalid-verdict test gets 404 where 400 is expected), the /act test fails at the quality assertion with `null !== 0.9` (the item has no `sourceRef`, so pre-fix `applyOutreachAction` hits its `default: return` no-op and the route returns 200 with the outcome never resolved), and the /reply test fails because the outcome stays pending (`false !== true`).

9. [ ] Edit `src/hosted-interface.js` — import the tone scorer. Replace:

```js
import { ChannelManager } from "./channels.js";
import { isFirstRun, renderWizard, saveEnv } from "./setup-wizard.js";
```

with:

```js
import { ChannelManager } from "./channels.js";
import { inferToneScore } from "./outcome-store.js";
import { isFirstRun, renderWizard, saveEnv } from "./setup-wizard.js";
```

10. [ ] Edit `src/hosted-interface.js` — add the /feedback route between /act and /reply. Replace:

```js
        } catch (error) {
          const updated = runtime.outreach.resolve(id, { action, by: "user" }, { status: "error", error: error.message });
          return sendJson(res, 400, { item: updated, error: error.message });
        }
      }
      if (method === "POST" && pathname.startsWith("/outreach/") && pathname.endsWith("/reply")) {
```

with:

```js
        } catch (error) {
          const updated = runtime.outreach.resolve(id, { action, by: "user" }, { status: "error", error: error.message });
          return sendJson(res, 400, { item: updated, error: error.message });
        }
      }
      if (method === "POST" && pathname.startsWith("/outreach/") && pathname.endsWith("/feedback")) {
        // Explicit thumbs: { verdict: "up" | "down" }. Mirrors /act exactly —
        // same 404, same already-resolved idempotency, same error path.
        const id = decodeURIComponent(pathname.slice("/outreach/".length, -"/feedback".length));
        const item = runtime.outreach?.get(id);
        if (!item) return sendJson(res, 404, { error: "unknown outreach item" });
        if (item.status === "acted" || item.status === "dismissed") {
          return sendJson(res, 200, { item });
        }
        const body = await readJson(req).catch(() => ({}));
        const verdict = String(body.verdict ?? "");
        if (verdict !== "up" && verdict !== "down") {
          return sendJson(res, 400, { error: "verdict must be 'up' or 'down'" });
        }
        try {
          await applyOutreachFeedback(runtime, item, verdict, body.note ?? null);
          const updated = runtime.outreach.resolve(id, { action: verdict, by: "user", note: body.note ?? null }, { status: "acted" });
          return sendJson(res, 200, { item: updated });
        } catch (error) {
          const updated = runtime.outreach.resolve(id, { action: verdict, by: "user" }, { status: "error", error: error.message });
          return sendJson(res, 400, { item: updated, error: error.message });
        }
      }
      if (method === "POST" && pathname.startsWith("/outreach/") && pathname.endsWith("/reply")) {
```

11. [ ] Edit `src/hosted-interface.js` — the user's outreach reply is also a tone verdict on the linked outcome. Replace:

```js
        if (!channels) return sendJson(res, 503, { error: "agent-host-disabled" });
        const body = await readJson(req);
        const forward = `Re: "${item.title}" (${item.type}, actions: ${item.actions.join("/")}).\nUser says: ${body.text ?? ""}\nInterpret intent and take the appropriate action.`;
```

with:

```js
        if (!channels) return sendJson(res, 503, { error: "agent-host-disabled" });
        const body = await readJson(req);
        // The reply text is ALSO the user's verdict on whatever produced this
        // item — resolve the linked outcome by tone before delegating (B2).
        if (item.outcomeId && runtime.outcomes?.resolve) {
          try { runtime.outcomes.resolve(item.outcomeId, inferToneScore(String(body.text ?? "")), "user-followup", "tone of outreach reply"); } catch { /* best effort */ }
        }
        const forward = `Re: "${item.title}" (${item.type}, actions: ${item.actions.join("/")}).\nUser says: ${body.text ?? ""}\nInterpret intent and take the appropriate action.`;
```

12. [ ] Edit `src/hosted-interface.js` — route thumbs arriving via /act to the shared feedback path. Replace:

```js
async function applyOutreachAction(runtime, item, action, note) {
  if (action === "dismiss") return;
  const ref = item.sourceRef ?? {};
```

with:

```js
async function applyOutreachAction(runtime, item, action, note) {
  if (action === "dismiss") return;
  // Thumbs verdicts can arrive through /act too (the Mac app posts every
  // action button to /act) — route them to the shared feedback path.
  if (action === "up" || action === "down") return applyOutreachFeedback(runtime, item, action, note);
  const ref = item.sourceRef ?? {};
```

13. [ ] Edit `src/hosted-interface.js` — add the feedback helper directly after `applyOutreachAction`. Replace:

```js
    default:
      return;
  }
}

function sendXml(res, status, value) {
```

with:

```js
    default:
      return;
  }
}

// Explicit thumbs feedback on an outreach item. Resolves the item's linked
// outcome (stamped at append time) at 0.9 (up) / 0.15 (down) with source
// "explicit-rating"; when no linked outcome exists — or it already resolved
// before the user reacted — records a fresh explicit-feedback outcome so the
// verdict still reaches the outcome store and downstream learners. Suggestion
// items additionally teach SuggestionFeedback by resolving the underlying
// proactive suggestion (status accepted/rejected — a preference vote only;
// materialization stays on POST /proactive/suggestions/:id/accept).
async function applyOutreachFeedback(runtime, item, verdict, note = null) {
  const score = verdict === "up" ? 0.9 : 0.15;
  const resolutionNote = note ?? `outreach thumbs-${verdict} on "${item.title}"`;
  let resolved = null;
  if (item.outcomeId && runtime.outcomes?.resolve) {
    resolved = runtime.outcomes.resolve(item.outcomeId, score, "explicit-rating", resolutionNote);
  }
  if (!resolved && runtime.outcomes?.record) {
    const fresh = runtime.outcomes.record({
      kind: "explicit-feedback",
      refId: item.id,
      metadata: { outreachType: item.type, sourceRef: item.sourceRef ?? null, verdict }
    });
    resolved = runtime.outcomes.resolve(fresh.id, score, "explicit-rating", resolutionNote);
  }
  if (item.sourceRef?.kind === "suggestion" && runtime.proactiveObserver?.resolve) {
    runtime.proactiveObserver.resolve(item.sourceRef.id, verdict === "up" ? "accepted" : "rejected", resolutionNote);
  }
  return resolved;
}

function sendXml(res, status, value) {
```

14. [ ] Run `node --test test/outreach-feedback.test.js`. Expect `# pass 7` / `# fail 0`.

15. [ ] Run the full suite scoped away from the live data dir: `OPENAGI_DATA_DIR="$(mktemp -d)" npm test`. Expect `# pass 360` / `# fail 3` (the same three pre-existing date flakes from B2.1's acceptance list; no new failures).

16. [ ] Commit: `git add src/hosted-interface.js test/outreach-feedback.test.js && git commit -m "feat(outreach): POST /outreach/:id/feedback resolves linked outcomes at 0.9/0.15 explicit-rating and teaches suggestion feedback"` then `git push`.

---

<!-- verified:B3 status=fixed:1 -->
### Task B3: Purge poisoned fitter training data + variance guard on auto-apply
**Week:** 2 · **Size:** L · **Depends on:** none
**User story:** As Spencer (the openAGI owner), I want the scrutiny fitter to stop training on 1394 stale June 7–16 outcomes written by an older pipeline, and to refuse to auto-apply weight changes fitted against near-constant dimensions, so that weekly weight calibration reflects how today's pipeline actually behaves instead of amplifying noise from dead data.
**Why (evidence):** G4 (wf-gaps.md): the fitter's ~1918-row training sample is dominated by 1394 outcomes resolved 2026-06-07..06-16 carrying an older `scrutinyDimensions` format that lacks the `risk`/`novelty`/`repetition` keys today's pipeline writes (src/agent-host.js:180 writes `output.scrutiny.dimensions`, whose shape is defined at src/directional-adaptive-scrutiny.js:48-57), and 3 of the 5 fitted dims in current rows are constant/near-constant (evidence is exactly 0.697 in all 524 live current-pipeline rows, so its Pearson delta is permanently zero). G5 confirms downstream learners train on this data. The fitter auto-applies after warmup with no variance check (src/scrutiny-fitter.js:152-154).
**Acceptance criteria:**
- `node --test test/scrutiny-fitter-variance.test.js` passes (2 tests): fit skips auto-apply and logs one line naming flat dims when ≥2 of the 5 dimensions have stddev < 0.02 across training rows; auto-applies normally when ≤1 dim is flat.
- The skipped proposal is still recorded in `pending-changes.json` with a `varianceGuard` field (checkable: `fitter.pending.proposals[0].varianceGuard.flatDimensions` in the test).
- `node --test test/purge-outcomes.test.js` passes (5 tests): dry run removes nothing, reports counts; real run writes a timestamped backup of the full snapshot BEFORE mutating and removes exactly the old-format in-window fixture rows.
- `OPENAGI_MIGRATE_DRY_RUN=1 node bin/openagi.js purge-outcomes` prints removed/kept counts and leaves `~/.openagi/outcomes/snapshot.json` byte-identical (verify with `shasum` before/after).
- The real purge run happens ONLY after Spencer has seen the dry-run counts and explicitly approved, with the daemon stopped by Spencer; afterwards `ls ~/.openagi/outcomes/` shows a `snapshot.backup-*.json` next to `snapshot.json`.
- `npm test` exits 0 with `# fail 0` (including the one existing test whose seed data this task must update, test/abi-runtime.test.js:748).
**Files:**
- Modify: src/scrutiny-fitter.js:19 (constants), src/scrutiny-fitter.js:126 (`fit()`), src/scrutiny-fitter.js:255 (append helpers)
- Modify: test/abi-runtime.test.js:748 (seed data of the judge-signal test — it currently seeds all-constant dims and asserts auto-apply)
- Modify: src/migrate.js:1 (imports), src/migrate.js:154 (append purge section)
- Modify: bin/openagi.js:201 (new command fn), bin/openagi.js:343 (help text), bin/openagi.js:385 (dispatch)
- Test: test/scrutiny-fitter-variance.test.js (create)
- Test: test/purge-outcomes.test.js (create)
**Interfaces:**
- Consumes (real signatures copied from source):
  - `ScrutinyFitter.fit({ now = new Date(), windowDays = 8 } = {})` returning `{ cycle, autoApplied, sampleCount, proposals }` or `{ skipped: true, reason }` (src/scrutiny-fitter.js:126)
  - `OutcomeStore` constructor `constructor(options = {})` with `options.dir`; `record(input)`; `resolve(id, qualityScore, source = "system-inferred", note = null)`; `recent(limit = 50, kind = null)` (src/outcome-store.js)
  - Snapshot shape written by `OutcomeStore.persist()`: `{ version: 1, updatedAt, outcomes: [...] }`; outcome rows carry `id, kind, resolved, qualityScore, scrutinyDimensions, at, resolvedAt, source, metadata` (src/outcome-store.js:23-46, 220-234). The store loads ONLY snapshot.json at boot (constructor lines 18-21); events.jsonl is append-only audit and is never replayed — so purging the snapshot is sufficient and the audit trail stays intact.
  - Current dims shape recorded at src/agent-host.js:180: `{ environment, company, evidence, memory, uncertainty, risk, novelty, repetition }` (src/directional-adaptive-scrutiny.js:48-57). The poisoned June rows lack `risk`/`novelty`/`repetition`.
  - `readJsonFile(filePath, fallback = null)`, `writeJsonAtomic(filePath, value, mode = 0o600)` (src/file-utils.js); `nowIso()` (src/utils.js); `resolveDataDir()` (src/data-dir.js)
  - bin/openagi.js `parseArgs` already maps `--dry-run` → `flags.dryRun` and `--json` → `flags.json`
- Produces (later tasks may rely on these):
  - `purgePoisonedOutcomes({ dataDir = resolveDataDir(), dryRun = process.env.OPENAGI_MIGRATE_DRY_RUN === "1", log = console.log } = {})` → `{ dryRun, snapshotPath, total, removed, kept, backupPath }` (exported from src/migrate.js)
  - `isPoisonedOutcome(outcome)` → boolean (exported from src/migrate.js)
  - `fit()` return gains `varianceGuard: null | { flatDimensions: string[], floor: 0.02 }`; guarded-skip proposals in `pending-changes.json` gain the same `varianceGuard` object
  - New CLI command: `openagi purge-outcomes [--dry-run] [--json]`

#### Steps

1. [ ] **Write the failing variance-guard test.** Create `test/scrutiny-fitter-variance.test.js` with exactly this content:

```js
// B3: variance guard — the scrutiny fitter must not auto-apply weight changes
// fitted against near-constant training dimensions (stddev < 0.02 on 2+ dims).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OutcomeStore } from "../src/outcome-store.js";
import { ScrutinyFitter } from "../src/scrutiny-fitter.js";

const DEFAULT_WEIGHTS = { environment: 0.28, company: 0.26, evidence: 0.24, memory: 0.12, uncertainty: 0.1 };

function makeRuntime(root) {
  return {
    outcomes: new OutcomeStore({ dir: path.join(root, "outcomes") }),
    scrutiny: { judges: { pragmatic: { weights: { ...DEFAULT_WEIGHTS } } } }
  };
}

function seed(runtime, makeDims, count = 50) {
  for (let i = 0; i < count; i += 1) {
    const dims = makeDims(i);
    const o = runtime.outcomes.record({ kind: "agent-reply", scrutinyAction: "act", scrutinyDimensions: dims });
    runtime.outcomes.resolve(o.id, dims.evidence, "system-inferred");
  }
}

test("variance guard skips auto-apply when 2+ dimensions are near-constant", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-varguard-"));
  const runtime = makeRuntime(root);
  // evidence varies; the other four dimensions are flat constants.
  seed(runtime, (i) => ({ environment: 0.5, company: 0.5, evidence: 0.3 + (i % 10) * 0.05, memory: 0.5, uncertainty: 0.5 }));

  const fitter = new ScrutinyFitter({ runtime, dir: path.join(root, "scrutiny"), warmupCycles: 0 });
  const before = { ...runtime.scrutiny.judges.pragmatic.weights };

  const warns = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warns.push(String(msg));
  let result;
  try {
    result = fitter.fit();
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(result.autoApplied, false, "guard must veto auto-apply");
  assert.deepEqual(result.varianceGuard.flatDimensions, ["environment", "company", "memory", "uncertainty"]);
  assert.deepEqual(runtime.scrutiny.judges.pragmatic.weights, before, "live weights untouched");
  assert.equal(fitter.pending.proposals.length, 1, "proposal stays recorded for manual review");
  assert.deepEqual(fitter.pending.proposals[0].varianceGuard.flatDimensions, ["environment", "company", "memory", "uncertainty"]);
  assert.equal(warns.length, 1, "exactly one guard log line");
  assert.ok(warns[0].includes("variance guard"), warns[0]);
  assert.ok(warns[0].includes("environment") && warns[0].includes("uncertainty"), warns[0]);
  fs.rmSync(root, { recursive: true });
});

test("variance guard lets varied dims auto-apply, including with one flat dim", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-varguard2-"));
  const runtime = makeRuntime(root);
  // Four varied dimensions, exactly ONE flat (memory) — below the 2-dim trip line.
  seed(runtime, (i) => ({
    environment: 0.3 + (i % 10) * 0.05,
    company: 0.3 + ((i + 2) % 10) * 0.05,
    evidence: 0.3 + ((i + 4) % 10) * 0.05,
    memory: 0.5,
    uncertainty: 0.3 + ((i + 6) % 10) * 0.05
  }));

  const fitter = new ScrutinyFitter({ runtime, dir: path.join(root, "scrutiny"), warmupCycles: 0 });
  const result = fitter.fit();
  assert.equal(result.autoApplied, true, "one flat dimension must not trip the guard");
  assert.equal(result.varianceGuard, null);
  assert.equal(fitter.pending.proposals.length, 0);
  fs.rmSync(root, { recursive: true });
});
```

2. [ ] **Run it and confirm it fails for the right reason.** Command: `cd /Users/you/Dev/openAGI && node --test test/scrutiny-fitter-variance.test.js`. Expected: both tests fail — test 1 with `AssertionError` message `guard must veto auto-apply` (actual `true`, expected `false`), test 2 with `Expected values to be strictly equal:` `undefined !== null` (because `result.varianceGuard` does not exist yet). If they fail with an import error instead, stop and fix the test file.

3. [ ] **Add the variance-floor constant.** In `/Users/you/Dev/openAGI/src/scrutiny-fitter.js`, replace:

```js
const DEFAULT_MIN_SAMPLES = 50;
const DEFAULT_MAX_DELTA = 0.05;
const DEFAULT_WARMUP = 4;
```

with:

```js
const DEFAULT_MIN_SAMPLES = 50;
const DEFAULT_MAX_DELTA = 0.05;
const DEFAULT_WARMUP = 4;
// B3 variance guard: if 2+ dimensions have stddev below this floor across the
// training rows, correlation deltas are noise — skip auto-apply for that cycle.
const VARIANCE_FLOOR = 0.02;
```

4. [ ] **Replace `fit()` with the guarded version.** In the same file, replace the entire current `fit` method (quoted exactly as it exists today, src/scrutiny-fitter.js:126-175):

```js
  fit({ now = new Date(), windowDays = 8 } = {}) {
    if (!this.runtime?.outcomes) throw new Error("ScrutinyFitter requires runtime.outcomes");
    if (!this.runtime?.scrutiny?.judges) {
      return { skipped: true, reason: "scrutiny is not a panel; nothing to fit" };
    }

    const outcomes = this.runtime.outcomes
      .recent(5000)
      .filter((o) => o.resolved && typeof o.qualityScore === "number" && o.scrutinyDimensions);
    if (outcomes.length < this.minSamples) {
      return { skipped: true, reason: `${outcomes.length} resolved outcomes, need ${this.minSamples}` };
    }

    const proposals = {};
    for (const judgeName of Object.keys(this.runtime.scrutiny.judges)) {
      const judge = this.runtime.scrutiny.judges[judgeName];
      const correlationDeltas = computeCorrelationDeltas(outcomes, this.maxDeltaPerCycle);
      const judgeSignal = aggregateJudgeSignals(this.state.judgeSignals, judgeName, this.maxDeltaPerCycle);
      const merged = mergeDeltas(correlationDeltas, judgeSignal);
      const proposed = applyDeltas(judge.weights, merged, this.maxDeltaPerCycle);
      proposals[judgeName] = { from: { ...judge.weights }, to: proposed, deltas: merged };
    }

    this.state.cycles += 1;
    this.state.lastRunAt = (now instanceof Date ? now : new Date(now)).toISOString();

    const autoApply = this.state.cycles > this.warmupCycles;
    if (autoApply) {
      this._applyAndPersist(proposals, { source: "auto-fit", cycle: this.state.cycles, at: this.state.lastRunAt });
    } else {
      this.pending.proposals.push({
        cycle: this.state.cycles,
        at: this.state.lastRunAt,
        proposals,
        applied: false
      });
      this.persistPending();
    }

    // Drained signals are kept in the audit log but no longer affect future cycles.
    this.state.judgeSignals = [];
    this.persistState();

    return {
      cycle: this.state.cycles,
      autoApplied: autoApply,
      sampleCount: outcomes.length,
      proposals
    };
  }
```

with this complete replacement:

```js
  fit({ now = new Date(), windowDays = 8 } = {}) {
    if (!this.runtime?.outcomes) throw new Error("ScrutinyFitter requires runtime.outcomes");
    if (!this.runtime?.scrutiny?.judges) {
      return { skipped: true, reason: "scrutiny is not a panel; nothing to fit" };
    }

    const outcomes = this.runtime.outcomes
      .recent(5000)
      .filter((o) => o.resolved && typeof o.qualityScore === "number" && o.scrutinyDimensions);
    if (outcomes.length < this.minSamples) {
      return { skipped: true, reason: `${outcomes.length} resolved outcomes, need ${this.minSamples}` };
    }

    const proposals = {};
    for (const judgeName of Object.keys(this.runtime.scrutiny.judges)) {
      const judge = this.runtime.scrutiny.judges[judgeName];
      const correlationDeltas = computeCorrelationDeltas(outcomes, this.maxDeltaPerCycle);
      const judgeSignal = aggregateJudgeSignals(this.state.judgeSignals, judgeName, this.maxDeltaPerCycle);
      const merged = mergeDeltas(correlationDeltas, judgeSignal);
      const proposed = applyDeltas(judge.weights, merged, this.maxDeltaPerCycle);
      proposals[judgeName] = { from: { ...judge.weights }, to: proposed, deltas: merged };
    }

    this.state.cycles += 1;
    this.state.lastRunAt = (now instanceof Date ? now : new Date(now)).toISOString();

    // B3 variance guard: correlations fitted against near-constant inputs are
    // noise. If 2+ dimensions are flat across the training rows, stage the
    // proposal for manual review instead of auto-applying it.
    const flatDims = flatDimensions(outcomes, VARIANCE_FLOOR);
    const guardTripped = flatDims.length >= 2;
    const autoApply = this.state.cycles > this.warmupCycles && !guardTripped;
    if (autoApply) {
      this._applyAndPersist(proposals, { source: "auto-fit", cycle: this.state.cycles, at: this.state.lastRunAt });
    } else {
      this.pending.proposals.push({
        cycle: this.state.cycles,
        at: this.state.lastRunAt,
        proposals,
        applied: false,
        ...(guardTripped ? { varianceGuard: { flatDimensions: flatDims, floor: VARIANCE_FLOOR } } : {})
      });
      this.persistPending();
      if (guardTripped && this.state.cycles > this.warmupCycles) {
        console.warn(`[scrutiny-fitter] variance guard: auto-apply skipped, ${flatDims.length} near-constant dimension(s) (stddev < ${VARIANCE_FLOOR}): ${flatDims.join(", ")}`);
      }
    }

    // Drained signals are kept in the audit log but no longer affect future cycles.
    this.state.judgeSignals = [];
    this.persistState();

    return {
      cycle: this.state.cycles,
      autoApplied: autoApply,
      varianceGuard: guardTripped ? { flatDimensions: flatDims, floor: VARIANCE_FLOOR } : null,
      sampleCount: outcomes.length,
      proposals
    };
  }
```

5. [ ] **Add the two helper functions.** Still in `/Users/you/Dev/openAGI/src/scrutiny-fitter.js`, replace:

```js
function clampDelta(value, maxDelta) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-maxDelta, Math.min(maxDelta, value));
}
```

with:

```js
function clampDelta(value, maxDelta) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-maxDelta, Math.min(maxDelta, value));
}

// Which of the fitted DIMENSIONS are near-constant across the training rows?
// Population stddev per dimension; a dimension with no numeric samples is
// skipped (its correlation delta is already 0).
function flatDimensions(outcomes, floor) {
  const flat = [];
  for (const dim of DIMENSIONS) {
    const xs = [];
    for (const o of outcomes) {
      const x = o.scrutinyDimensions?.[dim];
      if (typeof x === "number") xs.push(x);
    }
    if (xs.length === 0) continue;
    if (stddev(xs) < floor) flat.push(dim);
  }
  return flat;
}

function stddev(xs) {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  let sq = 0;
  for (const x of xs) sq += (x - mean) * (x - mean);
  return Math.sqrt(sq / n);
}
```

6. [ ] **Fix the one existing test that seeds all-constant dims and expects auto-apply.** In `/Users/you/Dev/openAGI/test/abi-runtime.test.js` (the test `"scrutiny fitter judge signal averages with correlation deltas"` at line 748), replace:

```js
test("scrutiny fitter judge signal averages with correlation deltas", () => {
  const runtime = createDefaultRuntime();
  for (let i = 0; i < 50; i += 1) {
    const dims = { environment: 0.5, company: 0.5, evidence: 0.5, memory: 0.5, uncertainty: 0.5 };
    const o = runtime.outcomes.record({ kind: "agent-reply", scrutinyAction: "act", scrutinyDimensions: dims });
    runtime.outcomes.resolve(o.id, 0.7, "system-inferred");
  }
```

with:

```js
test("scrutiny fitter judge signal averages with correlation deltas", () => {
  const runtime = createDefaultRuntime();
  for (let i = 0; i < 50; i += 1) {
    // Varied dims so the B3 variance guard doesn't veto auto-apply; quality is
    // constant so correlation deltas stay 0 and the judge signal dominates.
    const dims = {
      environment: 0.3 + (i % 10) * 0.05,
      company: 0.3 + ((i + 2) % 10) * 0.05,
      evidence: 0.3 + ((i + 4) % 10) * 0.05,
      memory: 0.3 + ((i + 6) % 10) * 0.05,
      uncertainty: 0.3 + ((i + 8) % 10) * 0.05
    };
    const o = runtime.outcomes.record({ kind: "agent-reply", scrutinyAction: "act", scrutinyDimensions: dims });
    runtime.outcomes.resolve(o.id, 0.7, "system-inferred");
  }
```

(Constant quality 0.7 makes `pearson` return 0 — its denominator is 0 — so correlation deltas are all 0 and the test's judge-signal assertion is unchanged in meaning. Do NOT touch the test at line 717, `"manually applying a staged warmup proposal persists the same way"` — it stages via warmup, so the guard doesn't change its behavior.)

7. [ ] **Run the new test.** `cd /Users/you/Dev/openAGI && node --test test/scrutiny-fitter-variance.test.js`. Expected: `# pass 2`, `# fail 0`.

8. [ ] **Run the full suite.** `cd /Users/you/Dev/openAGI && npm test`. Expected: exit code 0 with `# fail 0`. If `abi-runtime.test.js` fails on a fitter test, re-check step 6 was applied exactly.

9. [ ] **Commit the guard.** `cd /Users/you/Dev/openAGI && git add src/scrutiny-fitter.js test/scrutiny-fitter-variance.test.js test/abi-runtime.test.js && git commit -m "fix(scrutiny): variance guard skips weight auto-apply when 2+ training dims are near-constant" && git push`

10. [ ] **Write the failing purge-migration test.** Create `test/purge-outcomes.test.js` with exactly this content:

```js
// B3: purge poisoned fitter training data — resolved outcomes from the
// 2026-06-07..06-16 UTC window whose scrutinyDimensions lack the current
// keys (risk/novelty/repetition) are removed from the outcomes snapshot.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isPoisonedOutcome, purgePoisonedOutcomes } from "../src/migrate.js";

const OLD_DIMS = { environment: 0.4, company: 0.5, evidence: 0.6, memory: 0.3, uncertainty: 0.2 };
const NEW_DIMS = { ...OLD_DIMS, risk: 0.35, novelty: 0.4, repetition: 0.35 };

function makeOutcome(id, { resolved = true, dims = OLD_DIMS, resolvedAt = "2026-06-10T12:00:00.000Z" } = {}) {
  return {
    id,
    kind: "agent-reply",
    resolved,
    qualityScore: resolved ? 0.7 : null,
    scrutinyDimensions: dims,
    at: "2026-06-10T11:00:00.000Z",
    resolvedAt: resolved ? resolvedAt : null,
    source: resolved ? "system-inferred" : null,
    metadata: {}
  };
}

function writeSnapshot(dataDir, outcomes) {
  const dir = path.join(dataDir, "outcomes");
  fs.mkdirSync(dir, { recursive: true });
  const snapshotPath = path.join(dir, "snapshot.json");
  fs.writeFileSync(snapshotPath, JSON.stringify({ version: 1, updatedAt: "2026-07-01T00:00:00.000Z", outcomes }, null, 2));
  return snapshotPath;
}

const FIXTURE = [
  makeOutcome("poisoned-1"),                                                     // old dims, mid-window -> removed
  makeOutcome("poisoned-2", { resolvedAt: "2026-06-07T00:00:00.000Z" }),         // window start, inclusive -> removed
  makeOutcome("poisoned-3", { resolvedAt: "2026-06-16T23:59:59.000Z" }),         // window end, inclusive -> removed
  makeOutcome("keep-new-dims", { dims: NEW_DIMS }),                              // in window but current format -> kept
  makeOutcome("keep-after-window", { resolvedAt: "2026-06-17T00:00:00.000Z" }),  // old dims, after window -> kept
  makeOutcome("keep-before-window", { resolvedAt: "2026-06-06T23:59:59.000Z" }), // old dims, before window -> kept
  makeOutcome("keep-pending", { resolved: false }),                              // pending -> kept
  makeOutcome("keep-null-dims", { dims: null })                                  // no dims recorded -> kept
];

test("isPoisonedOutcome matches only old-format resolved rows inside the window", () => {
  assert.equal(isPoisonedOutcome(FIXTURE[0]), true);
  assert.equal(isPoisonedOutcome(FIXTURE[1]), true);
  assert.equal(isPoisonedOutcome(FIXTURE[2]), true);
  for (const keeper of FIXTURE.slice(3)) assert.equal(isPoisonedOutcome(keeper), false, keeper.id);
});

test("dry run reports counts and changes nothing", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-purge-dry-"));
  const snapshotPath = writeSnapshot(dataDir, FIXTURE);
  const original = fs.readFileSync(snapshotPath, "utf8");
  const lines = [];

  const result = purgePoisonedOutcomes({ dataDir, dryRun: true, log: (m) => lines.push(m) });

  assert.equal(result.dryRun, true);
  assert.equal(result.total, 8);
  assert.equal(result.removed, 3);
  assert.equal(result.kept, 5);
  assert.equal(result.backupPath, null);
  assert.equal(fs.readFileSync(snapshotPath, "utf8"), original, "snapshot untouched");
  assert.deepEqual(fs.readdirSync(path.join(dataDir, "outcomes")), ["snapshot.json"], "no backup on dry run");
  assert.ok(lines.some((l) => l.includes("removed=3") && l.includes("kept=5")), lines.join("\n"));
  fs.rmSync(dataDir, { recursive: true });
});

test("real run backs up first, removes exactly the seeded old-format rows", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-purge-real-"));
  const snapshotPath = writeSnapshot(dataDir, FIXTURE);
  const original = fs.readFileSync(snapshotPath, "utf8");

  const result = purgePoisonedOutcomes({ dataDir, dryRun: false, log: () => {} });

  assert.equal(result.removed, 3);
  assert.equal(result.kept, 5);
  assert.ok(result.backupPath, "backup path reported");
  assert.equal(fs.readFileSync(result.backupPath, "utf8"), original, "backup is the byte-exact pre-purge snapshot");

  const after = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  assert.deepEqual(
    after.outcomes.map((o) => o.id).sort(),
    ["keep-after-window", "keep-before-window", "keep-new-dims", "keep-null-dims", "keep-pending"]
  );
  assert.equal(after.version, 1);
  fs.rmSync(dataDir, { recursive: true });
});

test("OPENAGI_MIGRATE_DRY_RUN=1 defaults to dry run", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-purge-env-"));
  const snapshotPath = writeSnapshot(dataDir, FIXTURE);
  const original = fs.readFileSync(snapshotPath, "utf8");
  process.env.OPENAGI_MIGRATE_DRY_RUN = "1";
  try {
    const result = purgePoisonedOutcomes({ dataDir, log: () => {} });
    assert.equal(result.dryRun, true);
    assert.equal(fs.readFileSync(snapshotPath, "utf8"), original);
  } finally {
    delete process.env.OPENAGI_MIGRATE_DRY_RUN;
  }
  fs.rmSync(dataDir, { recursive: true });
});

test("missing snapshot is a safe no-op", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-purge-none-"));
  const result = purgePoisonedOutcomes({ dataDir, dryRun: false, log: () => {} });
  assert.equal(result.total, 0);
  assert.equal(result.removed, 0);
  assert.equal(result.kept, 0);
  assert.equal(result.backupPath, null);
  fs.rmSync(dataDir, { recursive: true });
});
```

11. [ ] **Run it and confirm the failure.** `cd /Users/you/Dev/openAGI && node --test test/purge-outcomes.test.js`. Expected failure: `SyntaxError: The requested module '../src/migrate.js' does not provide an export named 'isPoisonedOutcome'` (the whole file fails to load — that is the expected red state).

12. [ ] **Add imports to src/migrate.js.** Replace (top of `/Users/you/Dev/openAGI/src/migrate.js`):

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
```

with:

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "./file-utils.js";
import { nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";
```

13. [ ] **Append the purge migration at the end of src/migrate.js.** Replace the current end of file:

```js
  return { ...plan, importedMemories, notes: extracted.notes };
}
```

with:

```js
  return { ...plan, importedMemories, notes: extracted.notes };
}

// ─── purge poisoned outcomes (B3) ──────────────────────────────────────────
//
// 2026-06-07..2026-06-16 UTC: an older pipeline wrote resolved outcomes whose
// scrutinyDimensions lack keys today's agent-host records (risk, novelty,
// repetition — see DirectionalAdaptiveScrutiny.evaluate). Those rows dominate
// the scrutiny fitter's training sample and don't reflect the current
// pipeline. This one-shot migration removes them from the outcomes snapshot.
// Safety: a timestamped backup of the full snapshot is written BEFORE any
// mutation, and OPENAGI_MIGRATE_DRY_RUN=1 (or dryRun: true) reports counts
// without changing anything. The append-only events.jsonl audit log is never
// touched — the store boots from snapshot.json alone.

const PURGE_WINDOW_START = "2026-06-07"; // inclusive, UTC (ISO prefix compare)
const PURGE_WINDOW_END_EXCLUSIVE = "2026-06-17"; // exclusive, UTC
const CURRENT_DIMENSION_KEYS = ["risk", "novelty", "repetition"];

export function isPoisonedOutcome(outcome) {
  if (!outcome || outcome.resolved !== true) return false;
  const dims = outcome.scrutinyDimensions;
  if (!dims || typeof dims !== "object") return false;
  const missingCurrentKey = CURRENT_DIMENSION_KEYS.some((key) => typeof dims[key] !== "number");
  if (!missingCurrentKey) return false;
  if (typeof outcome.resolvedAt !== "string") return false;
  return outcome.resolvedAt >= PURGE_WINDOW_START && outcome.resolvedAt < PURGE_WINDOW_END_EXCLUSIVE;
}

export function purgePoisonedOutcomes({
  dataDir = resolveDataDir(),
  dryRun = process.env.OPENAGI_MIGRATE_DRY_RUN === "1",
  log = console.log
} = {}) {
  const snapshotPath = path.join(dataDir, "outcomes", "snapshot.json");
  const snap = readJsonFile(snapshotPath, null);
  if (!snap || !Array.isArray(snap.outcomes)) {
    log(`purge-outcomes: no snapshot at ${snapshotPath} — nothing to do.`);
    return { dryRun, snapshotPath, total: 0, removed: 0, kept: 0, backupPath: null };
  }

  const kept = [];
  const removed = [];
  for (const outcome of snap.outcomes) {
    if (isPoisonedOutcome(outcome)) removed.push(outcome);
    else kept.push(outcome);
  }

  const label = dryRun ? "purge-outcomes (dry run)" : "purge-outcomes";
  log(`${label}: ${snap.outcomes.length} outcomes in ${snapshotPath}`);
  log(`${label}: removed=${removed.length} (old dims format, resolved 2026-06-07..2026-06-16 UTC), kept=${kept.length}${dryRun ? " — no changes written" : ""}`);

  let backupPath = null;
  if (!dryRun && removed.length > 0) {
    backupPath = path.join(dataDir, "outcomes", `snapshot.backup-${nowIso().replace(/[:.]/g, "-")}.json`);
    fs.copyFileSync(snapshotPath, backupPath); // full backup BEFORE mutating
    writeJsonAtomic(snapshotPath, { version: snap.version ?? 1, updatedAt: nowIso(), outcomes: kept });
    log(`${label}: backup written to ${backupPath}`);
  }

  return { dryRun, snapshotPath, total: snap.outcomes.length, removed: removed.length, kept: kept.length, backupPath };
}
```

14. [ ] **Run the purge test.** `cd /Users/you/Dev/openAGI && node --test test/purge-outcomes.test.js`. Expected: `# pass 5`, `# fail 0`.

15. [ ] **Wire the CLI command (function).** In `/Users/you/Dev/openAGI/bin/openagi.js`, replace:

```js
async function cmdImessageServer(flags) {
```

with:

```js
async function cmdPurgeOutcomes(flags) {
  const { purgePoisonedOutcomes } = await import("../src/migrate.js");
  const dryRun = flags.dryRun === true || flags.check === true || process.env.OPENAGI_MIGRATE_DRY_RUN === "1";
  const result = purgePoisonedOutcomes({ dryRun });
  if (flags.json) { console.log(JSON.stringify(result, null, 2)); return 0; }
  if (result.dryRun) console.log(c(YELLOW, "\n(dry run — nothing changed. Stop the daemon, then re-run without --dry-run to purge.)"));
  else if (result.removed > 0) console.log(c(GREEN, `✓ purged ${result.removed} poisoned outcomes (backup: ${result.backupPath})`) + c(DIM, "\nRestart the daemon so it reloads the cleaned snapshot."));
  else console.log(c(GREEN, "✓ nothing to purge."));
  return 0;
}

async function cmdImessageServer(flags) {
```

16. [ ] **Wire the CLI command (dispatch + help).** Two edits in the same file. First, replace:

```js
      case "migrate": return await cmdMigrate(positional, flags);
```

with:

```js
      case "migrate": return await cmdMigrate(positional, flags);
      case "purge-outcomes": return await cmdPurgeOutcomes(flags);
```

Second, replace:

```js
  openagi migrate <openclaw|hermes> [--from D] [--dry-run]
                              import another agent's persona, memory + telegram
```

with:

```js
  openagi migrate <openclaw|hermes> [--from D] [--dry-run]
                              import another agent's persona, memory + telegram
  openagi purge-outcomes [--dry-run]
                              one-shot: drop poisoned Jun 7-16 old-format rows
                              from the outcomes snapshot (backs up first)
```

17. [ ] **Smoke-test the CLI against a scratch dir (NOT the live data dir).** Command: `cd /Users/you/Dev/openAGI && OPENAGI_DATA_DIR=$(mktemp -d) node bin/openagi.js purge-outcomes --dry-run`. Expected output includes `purge-outcomes: no snapshot at` and the yellow dry-run note. (resolveDataDir memoizes per process, so the env var fully isolates this run.)

18. [ ] **Run the full suite.** `cd /Users/you/Dev/openAGI && npm test`. Expected: exit 0, `# fail 0`.

19. [ ] **Commit the migration.** `cd /Users/you/Dev/openAGI && git add src/migrate.js bin/openagi.js test/purge-outcomes.test.js && git commit -m "feat(migrate): purge-outcomes removes poisoned Jun 7-16 old-format outcomes with pre-mutation backup and dry-run" && git push`

20. [ ] **Live dry run (safe — prints counts only, reads nothing personal aloud).** Command: `cd /Users/you/Dev/openAGI && node bin/openagi.js purge-outcomes --dry-run`. This targets `~/.openagi` (the live data dir; the repo-local `.openagi` is a stale dev snapshot and is NOT touched because resolveDataDir never uses cwd). Capture the two count lines (`total`, `removed=`, `kept=`). Do NOT open, cat, or quote the snapshot file itself — the counts printed by the command are the only thing you report.

21. [ ] **STOP — get Spencer's explicit approval.** Show Spencer the dry-run counts (expected ballpark from the verified dossier: ~1394 removed out of ~2000). Ask two things: (a) explicit go-ahead to purge, and (b) that HE stops the OpenAGI daemon / Mac app himself first — the daemon holds outcomes in memory and would overwrite the cleaned snapshot on its next persist. Do not kill any process yourself, and do not proceed without his confirmation. If the removed count is wildly different from ~1394 (e.g. 0, or nearly all rows), stop and report instead of running the purge.

22. [ ] **Live real run (only after step 21 approval and daemon stopped).** Command: `cd /Users/you/Dev/openAGI && node bin/openagi.js purge-outcomes`. Then verify the backup exists by listing filenames only: `ls ~/.openagi/outcomes/`. Report to Spencer: removed/kept counts, the backup file path, and ask him to restart the daemon/Mac app. Also tell him: the paired Distiller main (192.0.2.30) runs its own daemon with its own `~/.openagi` — if its snapshot has the same poisoned window, he can run the same `openagi purge-outcomes --dry-run` / real-run sequence there after pulling this commit. Note for him: the next weekly `scrutiny-fit` cron will now train only on current-format rows (the ~524 post-June-17 rows exceed the fitter's minSamples of 50), and the new variance guard will refuse auto-apply while 2+ of those dims remain near-constant — expect `[scrutiny-fitter] variance guard:` lines in the daemon log until upstream axis measurement improves.
