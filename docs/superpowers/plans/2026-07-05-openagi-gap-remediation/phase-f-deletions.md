# Phase F: Delete Unearned Adaptivity (Week 6)

> **Read `00-INDEX.md` first** — its Global Constraints, decision gates, and execution protocol apply to every task below.
>
> **Drift rule:** Tasks in this plan share hot files (collision table in `00-INDEX.md`). If a Before-quote fails to match byte-for-byte and the difference is explained by an EARLIER task in this plan having edited that region (e.g. a new entry appended to `MAP` in `src/outreach-mapper.js`), apply the edit by intent — make the same change relative to the current code — and say so in the commit body. If the drift is NOT explained by an earlier plan task, STOP and report; the repo has moved since 2026-07-05.


---

<!-- verified:F1 status=fixed:5 -->

### Task F1: Delete unearned adaptivity; implement the harsh-review act-threshold for real
**Week:** 6 · **Size:** L · **Depends on:** none
**User story:** As Spencer (the openAGI owner), I want the dead adaptivity machinery (vocabulary curator, LLM scrutiny judge, Twilio channel) deleted and the weekly harsh review to actually raise the scrutiny act threshold to 0.85, so that the system's remaining loops are all real, and the B3 pulse from abi-completion.md does what the spec says instead of being prompt-only theater.

**Why (evidence):** G7 (confirmed): the weekly-harsh-review job carries only `{agentId, prompt}` (src/abi-runtime.js:246-257), `DirectionalAdaptiveScrutiny.evaluate/selectAction` (src/directional-adaptive-scrutiny.js:23, 104) accepts no per-turn threshold override, and no code path anywhere writes scrutiny thresholds — the spec's defining 0.68→0.85 mechanic is unimplemented. G9 (partial/confirmed core): `VocabularyCurator` and `ScrutinyJudge` are constructed (abi-runtime.js:174, 173) but the curation loop can never run unattended (merges need a dashboard click at hosted-interface.js:484-487; deprecations have no apply method at all; zero vocab-merge events ever on the live install), and the judge trains weight nudges on outcomes whose inputs are near-constant (G4/G5). The Twilio channel has never been configured live (introspector "outbound not configured"; the wf-recommendations architecture plan item 5 calls for deleting all three). **Spencer has already approved every deletion in this task by accepting this plan.** Each deletion is its own commit and fully recoverable via `git revert`.

**Acceptance criteria:**
- `ls src/vocabulary-curator.js src/scrutiny-judge.js` → both "No such file or directory".
- `grep -rn "vocabulary-curator\|VocabularyCurator\|runtime.vocabulary\|renderVocab" /Users/you/Dev/openAGI/src /Users/you/Dev/openAGI/test` → no output.
- `grep -rn "scrutiny-judge\|ScrutinyJudge\|scrutinyJudge" /Users/you/Dev/openAGI/src /Users/you/Dev/openAGI/test` → no output.
- `grep -rln "Twilio\|twilio\|SmsChannel" /Users/you/Dev/openAGI/src /Users/you/Dev/openAGI/test` → prints only `/Users/you/Dev/openAGI/src/setup-wizard.js` (intentionally untouched, see step 26 note).
- `node --test test/harsh-review-threshold.test.js` → all 6 tests pass.
- `cd /Users/you/Dev/openAGI && npm test` → exit code 0, summary line `# fail 0`, after **each** of the five commits.
- `node -e "import('./src/abi-runtime.js').then(m => { const r = m.createDefaultRuntime(); console.log(JSON.stringify(r.cron.listJobs().find(j => j.id === 'weekly-harsh-review').input.scrutinyOverrides)); })"` run from the repo root prints `{"act":0.85}`.
- `git log --oneline -5` shows five commits, one per part below.

**Files:**
- Delete: src/vocabulary-curator.js
- Delete: src/scrutiny-judge.js
- Modify: src/abi-runtime.js:41 (import), :51 (import), :96 (insert constant after), :173-174 (constructions), :246-257 (harsh-review job), :284-291 (judge cron job), :486-491 (processSignal evaluate call), :654-656 (dispatcher branch), :942-975 (runAutopilot)
- Modify: src/index.js:4-11 (auth exports), :37 (ScrutinyJudge export), :40 (VocabularyCurator export)
- Modify: src/hosted-interface.js:7-15 (import), :25, :30-39, :280-283, :363-393, :477-488, :513-520, :940-953, :1074-1091, :1534-1537, :1565-1576, :1991, :2000, :2011-2012, :2320-2322, :2715, :2717, :3283-3322 (renderChannels), :3477-3480 + :3531-3535 (judge button), :3538-3579 (renderVocab), :4204-4206, :4929 (VALID_TABS)
- Modify: src/channels.js:18-24, :46-55, :60-63, :88-94, :201-247
- Modify: src/auth.js:38-48, :74-81
- Modify: src/introspector.js:1-4 (header comment), :52 (Twilio finding)
- Modify: src/tool-registry.js:313, :354, :358-359
- Modify: src/agent-host.js:75 (handleMessage), :261-297 (messageToSignal)
- Modify: src/directional-adaptive-scrutiny.js:23-60 (evaluate), :104-118 (selectAction)
- Modify: README.md:214-215, :221, :229-231, :241-261
- Modify: test/abi-runtime.test.js:6-29 (import), :131-140, :370-384, :839-851, :3244-3247
- Test: test/harsh-review-threshold.test.js (new)

**Interfaces:**
- Consumes (exact current signatures, copied from source):
  - `evaluate({ signal, workflow, memories = [], context = {} })` — src/directional-adaptive-scrutiny.js:23
  - `selectAction({ score, risk, novelty, propagationPressure, memories, signal })` — src/directional-adaptive-scrutiny.js:104
  - `evaluate(args)` on `ScrutinyPanel` (src/scrutiny-panel.js:42) — forwards `args` unchanged to each judge via `judge.evaluate(args)`, so **no change to scrutiny-panel.js is needed**; a new key in the args object flows through to all three judges automatically.
  - `processSignal(signal, options = {})` — src/abi-runtime.js:480
  - `async handleMessage(input)` — src/agent-host.js:22
  - `messageToSignal({ text, channel, from, agent, sessionId, metadata })` — src/agent-host.js:261
  - `async runAutopilot(job)` — src/abi-runtime.js:942
  - `addJob(job)` — src/cron-scheduler.js:8 (NOTE: returns the existing job unchanged when the id already exists and `job.replace !== true`; this is why step 55 adds an id-keyed fallback in runAutopilot for the already-persisted live job).
- Produces (later tasks may rely on these):
  - `DirectionalAdaptiveScrutiny.evaluate({ signal, workflow, memories, context, overrides })` where `overrides` is `{ act?: number }` (empty object = no override).
  - `DirectionalAdaptiveScrutiny.selectAction({ score, risk, novelty, propagationPressure, memories, signal, actThresholdOverride = null })`.
  - Signal objects may carry `scrutinyOverrides: { act: number } | null`; `AbiRuntime.processSignal` forwards `signal.scrutinyOverrides ?? {}` as `overrides` into `this.scrutiny.evaluate(...)`.
  - `AgentHost.handleMessage(input)` accepts `input.scrutinyOverrides` and attaches it to the signal via `messageToSignal`.
  - Module-level constant `HARSH_REVIEW_SCRUTINY_OVERRIDES = { act: 0.85 }` in src/abi-runtime.js (module-private; not exported).
  - The `weekly-harsh-review` cron job's `input` gains `scrutinyOverrides: { act: 0.85 }`.

General rules for every step: work in /Users/you/Dev/openAGI on branch main. Never read file contents under ~/.openagi (live personal data); the repo-local .openagi is a stale snapshot — touch neither. src/hosted-interface.js's dashboard code lives inside a Node template literal: the `\`` and `\${` escapes you see below are literal characters in the file — reproduce them byte-for-byte, and never add comments containing a raw backtick or `${` there.

---

**Part A — delete src/vocabulary-curator.js (commit 1)**

1. [ ] Run: `git rm src/vocabulary-curator.js`
2. [ ] In src/abi-runtime.js delete the import line (line 51). Before:
```js
import { composeDigest } from "./outreach-digest.js";
import { VocabularyCurator } from "./vocabulary-curator.js";
import { MemorySystem } from "./memory-system.js";
```
After:
```js
import { composeDigest } from "./outreach-digest.js";
import { MemorySystem } from "./memory-system.js";
```
3. [ ] In src/abi-runtime.js delete the construction (line 174). Before:
```js
    this.vocabulary = options.vocabulary ?? new VocabularyCurator({ runtime: this, ...(options.vocabularyOptions ?? {}) });
    this.introspector = options.introspector ?? new Introspector({ runtime: this });
```
After:
```js
    this.introspector = options.introspector ?? new Introspector({ runtime: this });
```
4. [ ] In src/index.js delete the export line. Before:
```js
export { VocabularyCurator } from "./vocabulary-curator.js";
export { MemorySystem } from "./memory-system.js";
```
After:
```js
export { MemorySystem } from "./memory-system.js";
```
5. [ ] In src/hosted-interface.js delete the two vocabulary routes (lines 477-488). Before:
```js
      if (method === "GET" && pathname === "/audit") return sendJson(res, 200, runtime.introspector?.audit?.() ?? null);
      if (method === "GET" && pathname === "/vocabulary") {
        return sendJson(res, 200, {
          snapshot: runtime.vocabulary.snapshot(),
          proposedMerges: runtime.vocabulary.proposeMerges(),
          proposedDeprecations: runtime.vocabulary.proposeDeprecations()
        });
      }
      if (method === "POST" && pathname === "/vocabulary/apply-merges") {
        const body = await readJson(req);
        const merges = body.merges ?? runtime.vocabulary.proposeMerges();
        return sendJson(res, 200, runtime.vocabulary.applyMerges(merges));
      }
```
After:
```js
      if (method === "GET" && pathname === "/audit") return sendJson(res, 200, runtime.introspector?.audit?.() ?? null);
```
Do NOT touch the memory event log plumbing (`memory.persist`) anywhere — the `applyMerges` caller is gone, `persist` itself stays.
6. [ ] In src/hosted-interface.js delete the Vocab nav button (line 2012). Before:
```js
            <button data-tab="scrutiny" title="Directional Adaptive Scrutiny — the 7-axis scorer's calibration + recent verdicts.">Scrutiny</button>
            <button data-tab="vocab" title="Vocabulary curator — how the agent thinks about your domain.">Vocab</button>
```
After:
```js
            <button data-tab="scrutiny" title="Directional Adaptive Scrutiny — the 7-axis scorer's calibration + recent verdicts.">Scrutiny</button>
```
7. [ ] In src/hosted-interface.js delete the vocab tab dispatch branch (lines 2320-2322). Before:
```js
  } else if (tab === "vocab") {
    showSidebar(false);
    await renderVocab();
  } else if (tab === "health") {
```
After:
```js
  } else if (tab === "health") {
```
8. [ ] In src/hosted-interface.js delete the entire `renderVocab` function (lines 3538-3579). Delete exactly this block (it sits between the closing `}` of `renderScrutiny` and `async function renderHealth() {`; reproduce the `\`` and `\${` escapes exactly when matching):
```js
async function renderVocab() {
  const data = await fetchJson("/vocabulary");
  const merges = data.proposedMerges ?? [];
  const top = (data.snapshot?.tags ?? []).slice(0, 60);
  const dormant = (data.proposedDeprecations ?? []).slice(0, 30);
  const mergeCards = merges.length === 0
    ? '<div class="empty">No near-synonym candidates right now.</div>'
    : merges.map((m) =>
      \`<div class="card"><div class="row between"><span class="name">\${escapeHtml(m.winner)}</span><span class="badge">sim \${m.similarity}</span></div><div class="desc">absorbs <code>\${escapeHtml(m.loser)}</code> · \${m.winnerCount} use\${m.winnerCount===1?"":"s"}</div></div>\`
    ).join("");
  const tagChips = top.length === 0
    ? '<div class="empty">No tags yet.</div>'
    : \`<div class="mem-tags">\${top.map((t) => \`<span class="chip">\${escapeHtml(t.tag)} · \${t.count}</span>\`).join("")}</div>\`;
  const dormantList = dormant.length === 0
    ? '<div class="empty">Nothing dormant.</div>'
    : \`<div class="mem-tags">\${dormant.map((t) => \`<span class="chip">\${escapeHtml(t.tag)}</span>\`).join("")}</div>\`;
  main.innerHTML = \`
    <div class="pane">
      <h2>Vocabulary</h2>
      <div class="grid stats">
        <div class="card"><span class="desc">Total tags</span><div class="stat-value">\${data.snapshot?.total ?? 0}</div></div>
        <div class="card"><span class="desc">Proposed merges</span><div class="stat-value">\${merges.length}</div></div>
        <div class="card"><span class="desc">Dormant tags</span><div class="stat-value">\${dormant.length}</div></div>
      </div>
      \${merges.length ? '<div class="row" style="margin:12px 0;"><button id="applyMergesBtn">Apply all merges</button></div>' : ""}
      <div id="vocabOut" class="muted" style="font-size:12px;"></div>
      <h3>Merge proposals</h3>
      <div class="grid">\${mergeCards}</div>
      <h3>Most-used tags</h3>
      \${tagChips}
      <h3>Dormant (last seen > 60d)</h3>
      \${dormantList}
    </div>
  \`;
  const btn = $("applyMergesBtn");
  if (btn) btn.addEventListener("click", async () => {
    try {
      $("vocabOut").textContent = JSON.stringify(await postJson("/vocabulary/apply-merges", {}), null, 2);
      setTimeout(renderVocab, 1000);
    } catch (e) { $("vocabOut").textContent = "[err] " + e.message; }
  });
}

```
9. [ ] In src/hosted-interface.js remove `"vocab"` from VALID_TABS (line 4929). Before:
```js
const VALID_TABS = new Set(["chat","tasks","memory","cron","skills","mcp","integrations","agents","channels","budget","outcomes","scrutiny","vocab","health","activity","suggestions","computer-use","today"]);
```
After:
```js
const VALID_TABS = new Set(["chat","tasks","memory","cron","skills","mcp","integrations","agents","channels","budget","outcomes","scrutiny","health","activity","suggestions","computer-use","today"]);
```
10. [ ] In test/abi-runtime.test.js delete the vocabulary test (lines 839-851). Delete exactly:
```js
test("vocabulary curator detects merge candidates and applies them", () => {
  const runtime = createDefaultRuntime();
  for (let i = 0; i < 6; i += 1) {
    runtime.memory.remember({ content: `note ${i}`, tags: ["calendar"], risk: 0.3 }, { tier: "short" });
  }
  for (let i = 0; i < 6; i += 1) {
    runtime.memory.remember({ content: `note ${i}`, tags: ["calendars"], risk: 0.3 }, { tier: "short" });
  }
  const merges = runtime.vocabulary.proposeMerges();
  assert.ok(merges.length >= 1, "expected at least one near-synonym merge proposal");
  const applied = runtime.vocabulary.applyMerges(merges);
  assert.ok(applied[0].touched > 0);
});

```
11. [ ] Verify: `grep -rn "vocabulary-curator\|VocabularyCurator\|runtime.vocabulary\|renderVocab\|proposeMerges\|proposeDeprecations\|applyMerges" src/ test/` → no output. (The phrase "action vocabulary" in test/abi-runtime.test.js:1198, src/skill-replay.js:4, and README.md:212 is the skill-replay action vocabulary — a different feature; it does not match any of these grep patterns and needs no change.)
12. [ ] Run: `npm test` → expect exit 0, `# fail 0`.
13. [ ] Commit: `git add -A && git commit -m "refactor(vocab): delete VocabularyCurator - propose-only curation that never ran unattended (G9)"`

---

**Part B — delete src/scrutiny-judge.js (commit 2)**

There are no tests referencing ScrutinyJudge (verified: `grep -rn "ScrutinyJudge\|scrutiny-judge\|scrutinyJudge" test/` returns nothing).

14. [ ] Run: `git rm src/scrutiny-judge.js`
15. [ ] In src/abi-runtime.js delete the import (line 41). Before:
```js
import { SkillReplay } from "./skill-replay.js";
import { ScrutinyJudge } from "./scrutiny-judge.js";
import { ScrutinyPanel } from "./scrutiny-panel.js";
```
After:
```js
import { SkillReplay } from "./skill-replay.js";
import { ScrutinyPanel } from "./scrutiny-panel.js";
```
16. [ ] In src/abi-runtime.js delete the construction (line 173). Before:
```js
    this.scrutinyJudge = options.scrutinyJudge ?? new ScrutinyJudge({ runtime: this, ...(options.scrutinyJudgeOptions ?? {}) });
    this.introspector = options.introspector ?? new Introspector({ runtime: this });
```
After:
```js
    this.introspector = options.introspector ?? new Introspector({ runtime: this });
```
(Note: step 3 already removed the vocabulary line that used to sit between these two.)
17. [ ] In src/abi-runtime.js delete the weekly cron registration (lines 284-291). Before:
```js
      this.cron.addJob({
        id: "weekly-scrutiny-judge",
        name: "Weekly LLM judge of scrutiny calibration",
        enabled: true,
        task: "scrutiny-judge",
        intervalMs: 7 * 24 * 60 * 60 * 1000,
        nextRunAt: nextSundayMorning(2).toISOString()
      });
      this.cron.addJob({
        id: "nightly-pattern-mine",
```
After:
```js
      this.cron.addJob({
        id: "nightly-pattern-mine",
```
Keep `nextSundayMorning` itself — the `weekly-scrutiny-fit` job still calls it.
18. [ ] In src/abi-runtime.js delete the dispatcher branch (lines 654-656). Before:
```js
      if (job.task === "scrutiny-judge") {
        return this.scrutinyJudge.judge();
      }
      if (job.task === "pattern-mine") {
```
After:
```js
      if (job.task === "pattern-mine") {
```
On the live install the already-persisted `weekly-scrutiny-judge` row in cron/jobs.json will now resolve to `{ skipped: true, reason: "No handler for task scrutiny-judge" }` at fire time — harmless by design (the dispatcher's final fallthrough at abi-runtime.js:731 handles unknown tasks); Spencer can delete the job row from the dashboard Cron tab whenever.
19. [ ] In src/index.js delete the export. Before:
```js
export { ScrutinyFitter } from "./scrutiny-fitter.js";
export { ScrutinyJudge } from "./scrutiny-judge.js";
export { ScrutinyPanel } from "./scrutiny-panel.js";
```
After:
```js
export { ScrutinyFitter } from "./scrutiny-fitter.js";
export { ScrutinyPanel } from "./scrutiny-panel.js";
```
20. [ ] In src/hosted-interface.js delete the trigger route (lines 513-520). Before:
```js
      if (method === "POST" && pathname === "/scrutiny/judge") {
        try {
          const result = await runtime.scrutinyJudge.judge();
          return sendJson(res, 200, result);
        } catch (error) {
          return sendJson(res, 500, { error: error.message });
        }
      }

      if (method === "GET" && pathname === "/outcomes") {
```
After:
```js
      if (method === "GET" && pathname === "/outcomes") {
```
21. [ ] In src/hosted-interface.js (inside `renderScrutiny`) delete the judge button (lines 3477-3480). Before:
```js
      <div class="row" style="gap:8px;margin-bottom:14px;">
        <button id="fitBtn">Run fit now</button>
        <button class="secondary" id="judgeBtn">Run LLM judge</button>
      </div>
```
After:
```js
      <div class="row" style="gap:8px;margin-bottom:14px;">
        <button id="fitBtn">Run fit now</button>
      </div>
```
Do NOT touch the `<h3>Judges</h3>` heading or the `judges` grid a few lines below — those render the three-judge *panel* weights, which stays.
22. [ ] In src/hosted-interface.js delete the judge button's click handler (lines 3531-3535, the last statement of `renderScrutiny`). Before:
```js
  $("fitBtn").addEventListener("click", async () => {
    showOut("fitting…");
    try { showOut(JSON.stringify(await postJson("/scrutiny/fit", {}), null, 2)); }
    catch (e) { showOut("[err] " + e.message); }
  });
  $("judgeBtn").addEventListener("click", async () => {
    showOut("running judge…");
    try { showOut(JSON.stringify(await postJson("/scrutiny/judge", {}), null, 2)); }
    catch (e) { showOut("[err] " + e.message); }
  });
}
```
After:
```js
  $("fitBtn").addEventListener("click", async () => {
    showOut("fitting…");
    try { showOut(JSON.stringify(await postJson("/scrutiny/fit", {}), null, 2)); }
    catch (e) { showOut("[err] " + e.message); }
  });
}
```
Leave `ScrutinyFitter.addJudgeSignal` in src/scrutiny-fitter.js alone — it is the fitter's public API and now simply has no caller.
23. [ ] Verify: `grep -rn "scrutiny-judge\|ScrutinyJudge\|scrutinyJudge" src/ test/` → no output. (docs/ROADMAP.md:77 still mentions it historically; leave docs alone in this commit.)
24. [ ] Run: `npm test` → expect exit 0, `# fail 0`.
25. [ ] Commit: `git add -A && git commit -m "refactor(scrutiny): delete ScrutinyJudge weekly LLM judge - trained on near-constant outcome inputs (G9, G4)"`

---

**Part C — delete the Twilio SMS channel, keep Telegram (commit 3)**

26. [ ] Scope guard, read before editing: do NOT touch `src/setup-wizard.js` (its Twilio env-field section becomes inert but harmless; the file is a template-literal minefield and is explicitly out of scope) and do NOT touch `docs/setup/remote-channels.md` (historical setup doc; flag it to Spencer as a follow-up in the PR/commit body if desired, but do not edit). `TelegramChannel`, the telegram webhook, and `verifyTelegramSecret` all stay.
27. [ ] In src/channels.js delete the SmsChannel construction in `ChannelManager` (lines 18-24). Before:
```js
    this.sms = new SmsChannel({
      agentHost: this.agentHost,
      dir: path.join(this.dir, "sms"),
      accountSid: options.twilioAccountSid ?? process.env.TWILIO_ACCOUNT_SID,
      authToken: options.twilioAuthToken ?? process.env.TWILIO_AUTH_TOKEN,
      fromNumber: options.twilioFromNumber ?? process.env.TWILIO_FROM_NUMBER
    });
    if (this.runtime) this.runtime.channels = this;
```
After:
```js
    if (this.runtime) this.runtime.channels = this;
```
28. [ ] In src/channels.js delete `handleSmsMessage` (lines 46-55). Before:
```js
  async handleSmsMessage(body) {
    return this.agentHost.handleMessage({
      channel: body.channel ?? "sms",
      from: body.from,
      agentId: body.agentId ?? "main",
      sessionId: body.sessionId,
      text: body.text,
      metadata: body.metadata ?? {}
    });
  }

  async deliver({ channel, target, text, sessionId = null, refId = null }) {
```
After:
```js
  async deliver({ channel, target, text, sessionId = null, refId = null }) {
```
29. [ ] In src/channels.js delete the sms branch in `deliver`. Before:
```js
    let result;
    if (channel === "telegram") result = await this.telegram.sendMessage(target, text);
    else if (channel === "sms") result = await this.sms.sendSms(target, text);
    else if (channel === "local" || channel === "cron") {
```
After:
```js
    let result;
    if (channel === "telegram") result = await this.telegram.sendMessage(target, text);
    else if (channel === "local" || channel === "cron") {
```
30. [ ] In src/channels.js drop sms from `status()`. Before:
```js
  status() {
    return {
      local: { enabled: true, mode: "http+sse" },
      sms: this.sms.status(),
      telegram: this.telegram.status()
    };
  }
```
After:
```js
  status() {
    return {
      local: { enabled: true, mode: "http+sse" },
      telegram: this.telegram.status()
    };
  }
```
31. [ ] In src/channels.js delete the entire `SmsChannel` class (lines 201-247, everything from `export class SmsChannel {` through its final `}` at end of file — i.e. the class whose body contains `mode: "twilio-webhook"`, `sendSms(to, body)`, and the `https://api.twilio.com/2010-04-01` URL). After deletion the file ends with the closing `}` of `TelegramChannel`.
32. [ ] In src/auth.js remove the twilio public route (line 44). Before:
```js
  return (
    pathname === "/health" ||
    pathname === "/sign-in" ||
    pathname === "/channels/twilio/webhook" ||
    pathname === "/channels/telegram/webhook" ||
    pathname === "/webhooks/buildbetter"
  );
```
After:
```js
  return (
    pathname === "/health" ||
    pathname === "/sign-in" ||
    pathname === "/channels/telegram/webhook" ||
    pathname === "/webhooks/buildbetter"
  );
```
33. [ ] In src/auth.js delete `verifyTwilioSignature` (lines 74-81). Delete exactly:
```js
export function verifyTwilioSignature({ authToken, fullUrl, params, signature }) {
  if (!authToken) return { ok: true, reason: "no twilio auth token configured" };
  if (!signature) return { ok: false, reason: "missing X-Twilio-Signature" };
  const sortedKeys = Object.keys(params).sort();
  const data = fullUrl + sortedKeys.map((k) => k + params[k]).join("");
  const expected = crypto.createHmac("sha1", authToken).update(data).digest("base64");
  return safeEqual(expected, signature) ? { ok: true } : { ok: false, reason: "twilio signature mismatch" };
}

```
34. [ ] In src/index.js remove it from the auth export block. Before:
```js
export {
  buildSetCookie,
  checkAuth,
  generateToken,
  isPublicRoute,
  verifyTelegramSecret,
  verifyTwilioSignature
} from "./auth.js";
```
After:
```js
export {
  buildSetCookie,
  checkAuth,
  generateToken,
  isPublicRoute,
  verifyTelegramSecret
} from "./auth.js";
```
35. [ ] In src/hosted-interface.js remove it from the import (lines 7-15). Before:
```js
import {
  buildSetCookie,
  checkAuth,
  checkOrigin,
  isPublicRoute,
  verifyTelegramSecret,
  verifyTwilioSignature,
  verifyBuildBetterWebhook
} from "./auth.js";
```
After:
```js
import {
  buildSetCookie,
  checkAuth,
  checkOrigin,
  isPublicRoute,
  verifyTelegramSecret,
  verifyBuildBetterWebhook
} from "./auth.js";
```
36. [ ] In src/hosted-interface.js delete `getTwilioAuthToken` (line 25). Before:
```js
  const getPublicUrl = () => options.publicUrl ?? process.env.OPENAGI_PUBLIC_URL ?? null;
  const getTwilioAuthToken = () => options.twilioAuthToken ?? process.env.TWILIO_AUTH_TOKEN ?? null;
  const getTelegramSecret = () => options.telegramSecret ?? process.env.TELEGRAM_WEBHOOK_SECRET ?? null;
```
After:
```js
  const getPublicUrl = () => options.publicUrl ?? process.env.OPENAGI_PUBLIC_URL ?? null;
  const getTelegramSecret = () => options.telegramSecret ?? process.env.TELEGRAM_WEBHOOK_SECRET ?? null;
```
37. [ ] In src/hosted-interface.js drop the twilio options from the ChannelManager construction (lines 30-39). Before:
```js
      ? new ChannelManager({
          agentHost: runtime.agentHost,
          runtime,
          dir: options.channelsDir,
          telegramToken: options.telegramToken,
          twilioAccountSid: options.twilioAccountSid,
          twilioAuthToken: options.twilioAuthToken,
          twilioFromNumber: options.twilioFromNumber
        })
```
After:
```js
      ? new ChannelManager({
          agentHost: runtime.agentHost,
          runtime,
          dir: options.channelsDir,
          telegramToken: options.telegramToken
        })
```
38. [ ] In src/hosted-interface.js drop the twilioWebhook field from GET /channels (line 283). Before:
```js
        return sendJson(res, 200, {
          ...status,
          publicUrl: pub,
          twilioWebhook: base ? `${base}/channels/twilio/webhook` : null,
```
After:
```js
        return sendJson(res, 200, {
          ...status,
          publicUrl: pub,
```
39. [ ] In src/hosted-interface.js delete both SMS routes (lines 363-393): the entire `if (method === "POST" && pathname === "/channels/twilio/webhook") { ... }` block (starts `if (!channels) return sendXml(res, 503, twiml("OpenAGI agent host is disabled."));`, ends `return sendXml(res, 200, twiml(result.reply));` + closing `}`) AND the entire `if (method === "POST" && pathname === "/channels/sms/send") { ... }` block that immediately follows (contains `channels.sms.sendSms(body.to, body.text)`). After the deletion, the line `if (method === "POST" && pathname === "/webhooks/buildbetter") {`'s block is followed directly by `if (method === "GET" && pathname === "/budget") ...`.
40. [ ] In src/hosted-interface.js delete the twilio entry from the integrations catalog (lines 940-953). Before:
```js
          {
            id: "twilio",
            name: "Twilio SMS",
            kind: "channel",
            description: "Two-way SMS — text the agent, get texts back. Outbound for proactive sends.",
            paths: [
              {
                kind: "api",
                label: "API credentials",
                configured: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
                envKeys: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"]
              }
            ]
          },
          {
            id: "telegram",
```
After:
```js
          {
            id: "telegram",
```
41. [ ] In src/hosted-interface.js update the drafts send route (lines 1074-1091). Before:
```js
      if (method === "POST" && pathname.match(/^\/drafts\/[^/]+\/send$/)) {
        // Explicit user-initiated send: route the draft body through a REAL
        // outbound transport (sms / telegram). This is the only path that
```
After:
```js
      if (method === "POST" && pathname.match(/^\/drafts\/[^/]+\/send$/)) {
        // Explicit user-initiated send: route the draft body through a REAL
        // outbound transport (telegram). This is the only path that
```
And the validation. Before:
```js
        if (!["sms", "telegram"].includes(channel)) {
          return sendJson(res, 400, { error: "send requires channel 'sms' or 'telegram' (email has no native transport — copy the approved draft into your mail client)" });
        }
```
After:
```js
        if (channel !== "telegram") {
          return sendJson(res, 400, { error: "send requires channel 'telegram' (email has no native transport — copy the approved draft into your mail client)" });
        }
```
42. [ ] In src/hosted-interface.js delete the now-unused XML helpers: the `sendXml` function (lines 1534-1537), the `twiml` function (lines 1565-1567), and the `escapeXml` function (lines 1569-1576) — `twiml`/`sendXml` had no callers left after step 39, and `escapeXml`'s only caller was `twiml`. Keep `readJson` and `readForm` (readForm is still used by POST /sign-in at line 175).
43. [ ] In src/hosted-interface.js update the two SMS tooltips. Line 1991 before/after: replace `and channels (SMS, Telegram).` with `and channels (Telegram).` inside the Integrations button title. Line 2000 before:
```js
            <button data-tab="channels" title="SMS / Telegram / webhook channels the agent can deliver through.">Channels</button>
```
After:
```js
            <button data-tab="channels" title="Telegram / webhook channels the agent can deliver through.">Channels</button>
```
44. [ ] In src/hosted-interface.js update the cron form channel picker (lines 2715-2717). Before:
```js
            <select class="ui-select" name="channel"><option value="local">local</option><option value="sms">sms</option><option value="telegram">telegram</option></select>
```
After:
```js
            <select class="ui-select" name="channel"><option value="local">local</option><option value="telegram">telegram</option></select>
```
And two lines below, before:
```js
          <div class="ui-grow"><label>Target (phone/chatId)</label><input class="ui-input" name="target" placeholder="+15555550123"></div>
```
After:
```js
          <div class="ui-grow"><label>Target (chatId)</label><input class="ui-input" name="target" placeholder="123456789"></div>
```
45. [ ] In src/hosted-interface.js replace `renderChannels` (lines 3283-3322) in full (note the literal `\`` / `\${` escapes). Before: the current function (fetches /channels, builds `tunnelBlock` with a "Twilio webhook:" line, renders an "SMS / Twilio" card, a "Send SMS test" form, and an `smsForm` submit handler posting to `/channels/sms/send`). After — the complete replacement:
```js
async function renderChannels() {
  const ch = await fetchJson("/channels");
  const bbWebhookLine = ch.buildBetterWebhook
    ? \`<div class="desc" style="margin-top:6px;">BuildBetter webhook: <code>\${escapeHtml(ch.buildBetterWebhook)}</code> <span class="sub">— paste into BuildBetter to sync calls instantly</span></div>\`
    : (ch.publicUrl ? \`<div class="desc" style="margin-top:6px;" class="sub">BuildBetter webhook: set <code>BUILDBETTER_WEBHOOK_SECRET</code> to enable instant call sync.</div>\` : "");
  const tunnelBlock = ch.publicUrl
    ? \`<div class="card"><div class="name">Public URL</div><div class="desc"><code>\${escapeHtml(ch.publicUrl)}</code></div>\${bbWebhookLine}</div>\`
    : \`<div class="card"><div class="name warn">No public URL</div><div class="desc">Run <code>npm run tunnel</code>, then set <code>OPENAGI_PUBLIC_URL</code> in .openagi/.env and restart.</div></div>\`;
  main.innerHTML = \`
    <div class="pane">
      <h2>Channels</h2>
      \${tunnelBlock}
      <div class="grid two" style="margin-top:12px;">
        <div class="card"><div class="name">Local · \${ch.local?.mode ?? ""}</div><div class="desc">Browser HTTP + SSE.</div></div>
        <div class="card"><div class="name">Telegram</div><div class="desc">\${ch.telegram?.configured ? "configured" : "no token"} · polling: \${ch.telegram?.polling ? "on" : "off"}</div></div>
      </div>
    </div>
  \`;
}
```
46. [ ] In src/hosted-interface.js update `renderToday`'s send-channel probe (lines 4204-4206). Before:
```js
  const sendChannels = [];
  if (chStatus?.sms?.outboundConfigured) sendChannels.push("sms");
  if (chStatus?.telegram?.configured) sendChannels.push("telegram");
```
After:
```js
  const sendChannels = [];
  if (chStatus?.telegram?.configured) sendChannels.push("telegram");
```
(The `ch === "sms" ? "📱 SMS" : "✈️ Telegram"` ternary at line 4280 becomes a dead branch — leave it; sendChannels can now only contain "telegram".)
47. [ ] In src/tool-registry.js update the two tool schemas. Line 313 before/after: replace `description: "Channel to deliver to: local, sms, telegram. Defaults to the originating channel."` with `description: "Channel to deliver to: local, telegram. Defaults to the originating channel."`. Then the send_message registration (lines 354-359). Before:
```js
    description: "Proactively send a message to a user via a channel (sms, telegram, or local). Use during autopilot pulses or when you decide to reach out unprompted. Returns delivery status.",
```
After:
```js
    description: "Proactively send a message to a user via a channel (telegram or local). Use during autopilot pulses or when you decide to reach out unprompted. Returns delivery status.",
```
Before:
```js
        channel: { type: "string", enum: ["sms", "telegram", "local"], description: "Channel to deliver via." },
        target: { type: "string", description: "Channel target — phone number for SMS, chat id for Telegram." },
```
After:
```js
        channel: { type: "string", enum: ["telegram", "local"], description: "Channel to deliver via." },
        target: { type: "string", description: "Channel target — chat id for Telegram." },
```
48. [ ] In src/introspector.js delete the dead Twilio finding (line 52). Before:
```js
    if (outcomeAgg7 && outcomeAgg7.avgQuality !== null && outcomeAgg7.avgQuality < 0.45) findings.push({ severity: "warn", area: "outcomes", note: `7-day avg outcome quality is ${outcomeAgg7.avgQuality}.` });
    if (channels && channels.sms?.outboundConfigured === false) findings.push({ severity: "info", area: "channels", note: "Twilio outbound not configured." });
```
After:
```js
    if (outcomeAgg7 && outcomeAgg7.avgQuality !== null && outcomeAgg7.avgQuality < 0.45) findings.push({ severity: "warn", area: "outcomes", note: `7-day avg outcome quality is ${outcomeAgg7.avgQuality}.` });
```
49. [ ] README.md edits (5 small edits): (a) line 214: replace `the reply to the originating channel (SMS, Telegram, local).` with `the reply to the originating channel (Telegram, local).`; (b) delete line 215 entirely: `| **SMS bidirectional** | Twilio inbound webhook → agent reply via TwiML. Twilio outbound REST for proactive sends and scheduled fires. |`; (c) line 221: replace `(chat / autopilot / cron / overlay / sms)` with `(chat / autopilot / cron / overlay)`; (d) line 229: replace heading `## Remote access (SMS, Telegram, tunneling)` with `## Remote access (Telegram, tunneling)` and on line 231 replace `you can reach it from anywhere via SMS or Telegram by pairing it with a public tunnel.` with `you can reach it from anywhere via Telegram by pairing it with a public tunnel.`; (e) delete the whole `### Twilio bidirectional SMS` section (lines 241-261, from the `### Twilio bidirectional SMS` heading through the closing triple-backtick of the `morning-nudge` curl example — the next line kept is `### Telegram`).
50. [ ] test/abi-runtime.test.js edits (4): (a) import list — before:
```js
  ToolRegistry,
  generateToken,
  registerCoreTools,
  verifyTwilioSignature
} from "../src/index.js";
```
after:
```js
  ToolRegistry,
  generateToken,
  registerCoreTools
} from "../src/index.js";
```
(b) inside `test("hosted interface exposes runtime health", ...)` delete the SMS webhook check (lines 131-140) — before:
```js
    assert.equal(messageBody.session.messageCount, 2);

    const smsResponse = await fetch(`${address.url}/channels/twilio/webhook`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        From: "+15555550123",
        Body: "Schedule a repeated risky task as a specialist."
      })
    });
    assert.equal(smsResponse.status, 200);
    assert.match(await smsResponse.text(), /<Response><Message>/);
  } finally {
```
after:
```js
    assert.equal(messageBody.session.messageCount, 2);
  } finally {
```
(c) delete the whole `test("twilio signature passes for valid HMAC and fails for tampered body", ...)` block (lines 370-384, from `test("twilio signature passes` through its closing `});`). (d) in `test("drafts: send endpoint routes through a real channel and marks sent only on delivery", ...)` switch the send channel — before:
```js
  // Real channel delivers + marks sent.
  resp = await fetch(`${address.url}/drafts/${d.id}/send`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel: "sms", target: "+15550000" })
  });
```
after:
```js
  // Real channel delivers + marks sent.
  resp = await fetch(`${address.url}/drafts/${d.id}/send`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel: "telegram", target: "+15550000" })
  });
```
Leave the `draft-store: markSent records transport` test alone — `markSent` stores an arbitrary channel string and touches no channel code.
51. [ ] Verify: `grep -rln "Twilio\|twilio\|SmsChannel\|handleSmsMessage\|sendSms" src/ test/` → prints exactly one file: `src/setup-wizard.js`.
52. [ ] Run: `npm test` → expect exit 0, `# fail 0`.
53. [ ] Commit: `git add -A && git commit -m "refactor(channels): delete Twilio SMS channel - never configured live, Telegram remains the off-Mac transport"`

---

**Part D — fix the Introspector's false header comment (commit 4)**

54. [ ] In src/introspector.js replace the header (lines 1-4). Before:
```js
// D5 — Introspector. Periodically (or on-demand) produces a structural
// audit of the runtime: specialist tree health, memory tier saturation,
// schedule load, budget burn, channel readiness. Drives the Health
// dashboard tab and the weekly autopilot review prompt.
```
After:
```js
// D5 — Introspector. On-demand structural audit of the runtime: specialist
// tree health, memory tier saturation, schedule load, budget burn, channel
// readiness. Surfaced via GET /audit (the Health dashboard tab) and the
// get_audit agent tool (tool-registry.js). Nothing schedules it: no cron
// job runs the audit, and the weekly harsh-review prompt does not
// reference it.
```
Keep the `get_audit` tool in src/tool-registry.js and the `GET /audit` route untouched. Then run `npm test` (expect `# fail 0`) and commit: `git add src/introspector.js && git commit -m "docs(introspector): correct header - audit is on-demand only, nothing drives a weekly review from it (G9)"`

---

**Part E — implement the B3 harsh-review act-threshold override (commit 5, TDD)**

55. [ ] Create test/harsh-review-threshold.test.js with exactly this content:
```js
// G7 / B3 (docs/scope/abi-completion.md:116-127): the weekly harsh review
// must actually raise the scrutiny act threshold (0.68 -> 0.85) for its
// turn, not just carry a skeptical prompt. Chain under test:
// cron job input.scrutinyOverrides -> runAutopilot -> agentHost.handleMessage
// -> messageToSignal -> processSignal -> DirectionalAdaptiveScrutiny.
import assert from "node:assert/strict";
import test from "node:test";
import { AbiRuntime, createDefaultRuntime } from "../src/abi-runtime.js";
import { AgentHost } from "../src/agent-host.js";
import { DirectionalAdaptiveScrutiny } from "../src/directional-adaptive-scrutiny.js";

const runAutopilot = AbiRuntime.prototype.runAutopilot;

test("selectAction: actThresholdOverride flips an act verdict to ask at 0.75", () => {
  const scrutiny = new DirectionalAdaptiveScrutiny(); // pragmatic defaults, act = 0.68
  const base = { score: 0.75, risk: 0.2, novelty: 0.3, propagationPressure: 0, memories: [{ score: 0.8 }], signal: {} };
  assert.equal(scrutiny.selectAction(base), "act");
  assert.equal(scrutiny.selectAction({ ...base, actThresholdOverride: 0.85 }), "ask");
});

test("evaluate: overrides.act raises the bar for the whole verdict", () => {
  const scrutiny = new DirectionalAdaptiveScrutiny();
  // Crafted so the composite score lands between 0.68 and 0.85 (~0.812).
  const signal = {
    urgency: 1, impact: 1, environmentalPressure: 1, externalPressure: 1,
    goalAlignment: 1, policyFit: 1, internalPressure: 1, strategicFit: 1,
    citations: [], specificity: 0.5, confidence: 0.5, conflict: 0,
    ambiguity: 0, risk: 0.2, novelty: 0.3, repetition: 0
  };
  const memories = [{ score: 0.9 }];
  const normal = scrutiny.evaluate({ signal, memories });
  assert.ok(normal.score > 0.68 && normal.score < 0.85, `score ${normal.score} must sit between the default and harsh act thresholds`);
  assert.equal(normal.action, "act");
  const harsh = scrutiny.evaluate({ signal, memories, overrides: { act: 0.85 } });
  assert.equal(harsh.action, "ask");
  assert.equal(harsh.score, normal.score, "override changes the verdict, not the score");
});

test("messageToSignal attaches scrutinyOverrides to the signal", () => {
  const signal = AgentHost.prototype.messageToSignal.call(null, {
    text: "weekly review", channel: "autopilot", from: "autopilot",
    agent: { id: "main" }, sessionId: "s1", metadata: {},
    scrutinyOverrides: { act: 0.85 }
  });
  assert.deepEqual(signal.scrutinyOverrides, { act: 0.85 });
});

test("processSignal passes signal.scrutinyOverrides into scrutiny.evaluate", () => {
  const seen = [];
  const runtime = createDefaultRuntime({
    scrutiny: {
      evaluate(args) {
        seen.push(args.overrides);
        return { action: "act", score: 0.8, propagationPressure: 0, dimensions: { risk: 0.2, novelty: 0.3, repetition: 0.2 }, reasons: ["stub"] };
      }
    }
  });
  const shape = {
    source: "test", type: "message", domain: "general", taskType: "adaptation-review",
    summary: "s", content: "c", tags: [], risk: 0.2, novelty: 0.3, repetition: 0.2
  };
  runtime.processSignal({ id: "sig_hr", ...shape, scrutinyOverrides: { act: 0.85 } });
  runtime.processSignal({ id: "sig_plain", ...shape });
  assert.deepEqual(seen[0], { act: 0.85 });
  assert.deepEqual(seen[1], {}, "no override degrades to an empty overrides object");
});

test("weekly-harsh-review job registration carries the act override", () => {
  const runtime = createDefaultRuntime();
  const job = runtime.cron.listJobs().find((j) => j.id === "weekly-harsh-review");
  assert.ok(job, "weekly-harsh-review must be registered by default");
  assert.deepEqual(job.input.scrutinyOverrides, { act: 0.85 });
});

test("runAutopilot forwards scrutinyOverrides into handleMessage, with an id-keyed fallback for legacy persisted jobs", async () => {
  const captured = [];
  const self = {
    agentHost: { handleMessage: async (input) => { captured.push(input.scrutinyOverrides); return { reply: "ok" }; } },
    budget: { check() {} },
    tasks: { agentPickNext: () => null }
  };
  await runAutopilot.call(self, { id: "weekly-harsh-review", input: { prompt: "review", scrutinyOverrides: { act: 0.85 } } });
  assert.deepEqual(captured[0], { act: 0.85 });
  // A jobs.json persisted before this feature has no scrutinyOverrides in its
  // saved input (CronScheduler.addJob keeps the existing row) — the runtime
  // falls back by job id so the deployed install still gets the raised bar.
  await runAutopilot.call(self, { id: "weekly-harsh-review", input: { prompt: "review" } });
  assert.deepEqual(captured[1], { act: 0.85 });
  // Ordinary autopilot pulses carry no override.
  await runAutopilot.call(self, { id: "agent-pulse", input: { prompt: "pulse" } });
  assert.equal(captured[2], null);
});
```
56. [ ] Run: `node --test test/harsh-review-threshold.test.js` → expect exit code 1 with **all 6 tests failing** (e.g. `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 'act' !== 'ask'` for the first two, and `deepStrictEqual` failures of `undefined` vs `{ act: 0.85 }` for the wiring tests). Summary lines end `# fail 6`.
57. [ ] In src/directional-adaptive-scrutiny.js replace `evaluate` in full. Before (current function, lines 23-60): the function whose signature is `evaluate({ signal, workflow, memories = [], context = {} })` and whose action line reads `const action = this.selectAction({ score, risk, novelty, propagationPressure, memories, signal });`. After — complete replacement:
```js
  evaluate({ signal, workflow, memories = [], context = {}, overrides = {} }) {
    const environmentScore = this.environmentPressure(signal, context);
    const companyScore = this.companyScrutiny(signal, workflow, context);
    const evidenceScore = this.evidenceQuality(signal);
    const memoryScore = this.memoryReadiness(memories);
    const uncertaintyScore = 1 - this.uncertainty(signal, memories);
    const risk = clamp(signal.risk ?? 0);
    const novelty = clamp(signal.novelty ?? 0);
    const repetition = clamp(signal.repetition ?? 0);

    const score = clamp(
      environmentScore * this.weights.environment +
        companyScore * this.weights.company +
        evidenceScore * this.weights.evidence +
        memoryScore * this.weights.memory +
        uncertaintyScore * this.weights.uncertainty
    );

    const propagationPressure = clamp(Math.max(repetition, risk * novelty, signal.requiresSpecialist ? 0.9 : 0));
    // Per-signal threshold override (B3 harsh review): overrides.act raises
    // the act bar for this evaluation only. Weights and the stored
    // thresholds are untouched.
    const actThresholdOverride = typeof overrides.act === "number" ? overrides.act : null;
    const action = this.selectAction({ score, risk, novelty, propagationPressure, memories, signal, actThresholdOverride });

    return {
      action,
      score,
      propagationPressure,
      dimensions: {
        environment: environmentScore,
        company: companyScore,
        evidence: evidenceScore,
        memory: memoryScore,
        uncertainty: 1 - uncertaintyScore,
        risk,
        novelty,
        repetition
      },
      reasons: this.reasons({ signal, workflow, context, score, action, propagationPressure, memories })
    };
  }
```
58. [ ] In src/directional-adaptive-scrutiny.js replace `selectAction` in full. Before (lines 104-118, the function starting `selectAction({ score, risk, novelty, propagationPressure, memories, signal }) {`). After — complete replacement:
```js
  selectAction({ score, risk, novelty, propagationPressure, memories, signal, actThresholdOverride = null }) {
    const actThreshold = actThresholdOverride ?? this.thresholds.act;
    if (propagationPressure >= this.thresholds.propagate && score >= this.thresholds.ask) return "propagate";
    if (score >= actThreshold && risk < 0.8) return "act";
    if (risk >= 0.8 && memories.length === 0) return "ask";
    if (novelty >= 0.75 && score >= this.thresholds.ask) return "ask";
    if (score >= this.thresholds.ask) {
      // An explicit raised act bar (weekly harsh review) means "do not press
      // ahead below the bar": the style fallbacks that return 'act' are
      // skipped so the override cannot be bypassed by an aggressive style
      // or a signal-supplied defaultAction.
      if (actThresholdOverride !== null) return "ask";
      // Style-differentiated fallback when score is between ask and act:
      // cautious hedges ('ask'), aggressive presses ahead ('act'), pragmatic uses signal default.
      if (this.style === "cautious") return "ask";
      if (this.style === "aggressive") return "act";
      return signal.defaultAction ?? "act";
    }
    if (score >= this.thresholds.watch) return "watch";
    return "ignore";
  }
```
No change to src/scrutiny-panel.js: `ScrutinyPanel.evaluate(args)` forwards `args` (now containing `overrides`) to all three judges unchanged.
59. [ ] In src/abi-runtime.js insert the override constant directly after the closing line of `HARSH_REVIEW_PROMPT`. Before:
```js
No generalities. Cite specific session ids, job names, specialist ids.`;

function nextSundayEvening() {
```
After:
```js
No generalities. Cite specific session ids, job names, specialist ids.`;

// B3 (docs/scope/abi-completion.md:116-127): the harsh review runs under a
// raised scrutiny act threshold (0.68 -> 0.85) so the agent must clear a
// much higher bar before acting unprompted during its own self-review turn.
const HARSH_REVIEW_SCRUTINY_OVERRIDES = { act: 0.85 };

function nextSundayEvening() {
```
60. [ ] In src/abi-runtime.js add the override to the weekly-harsh-review registration. Before:
```js
      this.cron.addJob({
        id: "weekly-harsh-review",
        name: "Weekly harsh review",
        enabled: true,
        task: "autopilot",
        intervalMs: 7 * 24 * 60 * 60 * 1000,
        nextRunAt: nextSundayEvening().toISOString(),
        input: {
          agentId: "main",
          prompt: HARSH_REVIEW_PROMPT
        }
      });
```
After:
```js
      this.cron.addJob({
        id: "weekly-harsh-review",
        name: "Weekly harsh review",
        enabled: true,
        task: "autopilot",
        intervalMs: 7 * 24 * 60 * 60 * 1000,
        nextRunAt: nextSundayEvening().toISOString(),
        input: {
          agentId: "main",
          prompt: HARSH_REVIEW_PROMPT,
          scrutinyOverrides: HARSH_REVIEW_SCRUTINY_OVERRIDES
        }
      });
```
61. [ ] In src/abi-runtime.js update `processSignal`'s evaluate call (line 486). Before:
```js
    const scrutiny = this.scrutiny.evaluate({
      signal,
      workflow,
      memories: memoryHits,
      context: this.context
    });
```
After:
```js
    const scrutiny = this.scrutiny.evaluate({
      signal,
      workflow,
      memories: memoryHits,
      context: this.context,
      overrides: signal.scrutinyOverrides ?? {}
    });
```
62. [ ] In src/abi-runtime.js replace `runAutopilot` in full. Before: the current function (lines 942-975). After — complete replacement (only the `scrutinyOverrides` const and the one new field in the handleMessage call differ):
```js
  async runAutopilot(job) {
    if (!this.agentHost) return { skipped: true, reason: "agent-host-disabled" };
    // Cheap gate (no tokens): a queue-draining pulse must NOT spend a base-model
    // call when there's nothing committed to do. Jobs opt in via
    // input.requireQueuedWork; scheduled review prompts (weekly-harsh-review)
    // leave it off and run unconditionally. This is the "react only to new work"
    // rule — the agent wakes only when agentPickNext has a real task.
    if (job.input?.requireQueuedWork && !this.tasks?.agentPickNext?.()) {
      return { skipped: true, reason: "no queued agent work" };
    }
    try {
      this.budget.check();
    } catch (error) {
      return { skipped: true, reason: error.message };
    }
    const input = job.input ?? {};
    const sessionId = input.sessionId ?? `autopilot:${job.id}`;
    const prompt = input.prompt ?? AUTOPILOT_DEFAULT_PROMPT;
    // B3: the harsh review runs under a raised act threshold. Cron stores
    // persisted before this field existed keep their old saved input
    // (CronScheduler.addJob returns the existing row), so fall back by job
    // id — an already-deployed weekly-harsh-review still gets the bar.
    const scrutinyOverrides = input.scrutinyOverrides
      ?? (job.id === "weekly-harsh-review" ? HARSH_REVIEW_SCRUTINY_OVERRIDES : null);
    const result = await this.agentHost.handleMessage({
      channel: "autopilot",
      from: "autopilot",
      agentId: input.agentId ?? "main",
      sessionId,
      text: prompt,
      scrutinyOverrides,
      metadata: {
        scheduledJobId: job.id,
        scheduledJobName: job.name,
        firedAt: nowIso()
      },
      origin: "autopilot"
    });
    result.autopilot = true;
    return result;
  }
```
63. [ ] In src/agent-host.js pass the override into the signal (line 75). Before:
```js
    const signal = this.messageToSignal({ text, channel, from, agent, sessionId, metadata: input.metadata ?? {} });
```
After:
```js
    const signal = this.messageToSignal({ text, channel, from, agent, sessionId, metadata: input.metadata ?? {}, scrutinyOverrides: input.scrutinyOverrides ?? null });
```
64. [ ] In src/agent-host.js replace `messageToSignal` in full. Before: the current function (lines 261-297). After — complete replacement (only the signature and the one new `scrutinyOverrides,` field differ):
```js
  messageToSignal({ text, channel, from, agent, sessionId, metadata, scrutinyOverrides = null }) {
    const lower = text.toLowerCase();
    const asksToRemember = /\bremember\b|\bsave\b|\bdon't forget\b/.test(lower);
    const asksToSchedule = /\bevery\b|\bdaily\b|\bweekly\b|\btomorrow\b|\bremind\b|\bschedule\b/.test(lower);
    const asksToSpecialize = /\bagent\b|\bspecialist\b|\bsub-?agent\b|\bdo this often\b|\bautomate\b/.test(lower);
    const risk = /\bdelete\b|\bdeploy\b|\bpayment\b|\bproduction\b|\blegal\b|\bmedical\b|\bsecurity\b/.test(lower) ? 0.75 : 0.35;
    const repetition = asksToSchedule || asksToSpecialize ? 0.82 : 0.35;
    const novelty = asksToRemember || asksToSpecialize ? 0.65 : 0.4;

    return {
      id: createId("sig"),
      source: channel,
      type: "message",
      domain: "general",
      taskType: asksToSpecialize ? "specialization-candidate" : "adaptation-review",
      summary: text.slice(0, 240),
      content: text,
      citations: [`session:${sessionId}`, `agent:${agent.id}`, `from:${from}`],
      tags: ["message", channel, agent.id],
      urgency: metadata.urgent ? 0.85 : 0.45,
      impact: asksToRemember || asksToSpecialize ? 0.72 : 0.55,
      externalPressure: 0.55,
      internalPressure: asksToSchedule ? 0.7 : 0.5,
      novelty,
      repetition,
      risk,
      ambiguity: 0.35,
      confidence: 0.7,
      specificity: 0.65,
      conflict: 0,
      goalAlignment: 0.75,
      strategicFit: 0.7,
      requiresSpecialist: asksToSpecialize || asksToSchedule,
      scrutinyOverrides,
      receivedAt: nowIso(),
      metadata
    };
  }
```
65. [ ] Run: `node --test test/harsh-review-threshold.test.js` → expect exit 0, `# tests 6`, `# pass 6`, `# fail 0`.
66. [ ] Run the full suite: `npm test` → expect exit 0, `# fail 0` (in particular test/autopilot-gate.test.js and test/verdict-consequences.test.js must still pass — the gate tests stub `handleMessage` and are unaffected by the extra field; the verdict tests stub `processSignal` and never reach `evaluate`).
67. [ ] Commit: `git add src/directional-adaptive-scrutiny.js src/abi-runtime.js src/agent-host.js test/harsh-review-threshold.test.js && git commit -m "feat(scrutiny): weekly harsh review raises the act threshold to 0.85 per B3 (G7)"`
