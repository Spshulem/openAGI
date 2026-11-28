import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { G2LiveCues, isDirectQuestion, isEchoCue, isRecallQuestion } from "../src/integrations/g2-agent.js";
import { G2Proactive } from "../src/g2-proactive.js";

// Synthetic data only: a stub model returns fixed JSON so these tests pin the
// filtering, grounding and rate rules around it, not model quality.
function cues({ replies = [], history = null, start = 1_000_000_000_000 } = {}) {
  let now = start;
  const calls = [];
  const generate = async (request) => { calls.push(request); return { text: JSON.stringify(replies.shift() ?? { cue: null }) }; };
  const live = new G2LiveCues({ channel: { assertEnrolled() {}, agentHost: { modelProvider: { generate } } }, runtime: {}, history, now: () => now });
  return { live, calls, tick: ms => { now += ms; }, now: () => now };
}
const cue = (brief, title = "Cue", kind = "answer") => ({ cue: { kind, title, brief, detail: `${brief} More detail.` } });
const ask = (live, text, consentId = "grant-1") => live.suggest({ text, timeZone: "UTC", consentId }, "node");

test("a direct question gets the answer itself, checked within seconds", async () => {
  const f = cues({ replies: [cue("Olympia.", "Capital of Washington")] });
  const result = await ask(f.live, "We should visit the coast.\nWhat's the capital of Washington?");
  assert.equal(result.cue.brief, "Olympia.");
  assert.match(f.calls[0].instructions, /answer it: brief is the answer itself/);
  // Ordinary speech still waits 30 seconds; a question needs only 5.
  f.tick(6_000);
  await assert.rejects(() => ask(f.live, "That was a nice drive"), { status: 429 });
  assert.equal((await ask(f.live, "Is it far from Seattle?")).cue, null);
  assert.equal(isDirectQuestion("capital of Washington?"), true);
  assert.equal(isDirectQuestion("I went to Washington"), false);
});

test("cues that echo the conversation or read back UI instructions stay quiet", async () => {
  const f = cues({ replies: [
    cue("You said you are meeting Dana at noon tomorrow.", "Meeting Dana", "context"),
    cue("Tap to expand the transcript on the glasses.", "Lifelog", "context"),
    cue("Dana's flight lands at 11:40, so noon is tight.", "Dana's flight", "context"),
  ] });
  const said = "I'm meeting Dana at noon tomorrow.";
  assert.equal((await ask(f.live, said)).cue, null);
  f.tick(30_001);
  assert.equal((await ask(f.live, said)).cue, null);
  f.tick(30_001);
  const useful = await ask(f.live, said);
  assert.equal(useful.cue.title, "Dana's flight");
  assert.equal(isEchoCue({ title: "Olympia", brief: "Olympia." }, "What's the capital of Washington?"), false);
});

test("the same fact is not shown twice", async () => {
  const fact = cue("Dana's flight lands at 11:40.", "Dana's flight", "context");
  const f = cues({ replies: [fact, fact] });
  assert.ok((await ask(f.live, "Dana is coming tomorrow")).cue);
  f.tick(30_001);
  assert.equal((await ask(f.live, "Dana is coming tomorrow, right")).cue, null);
});

test("recall questions are grounded only in consented history and say when capture was unavailable", async () => {
  assert.equal(isRecallQuestion("what did we talk about five minutes ago?"), true);
  assert.equal(isRecallQuestion("What was I just saying?"), true);
  assert.equal(isRecallQuestion("what is the weather"), false);

  // No consent (or a stale grant): no model call, an honest answer.
  const off = cues({ history: () => ({ available: false }) });
  const unavailable = await ask(off.live, "What did we talk about five minutes ago?");
  assert.match(unavailable.cue.brief, /wasn't capturing/);
  assert.equal(off.calls.length, 0);

  // Consented but nothing saved for that time.
  const empty = cues({ history: () => ({ available: true, segments: [] }) });
  assert.match((await ask(empty.live, "What was I just saying?")).cue.brief, /No words were saved/);
  assert.equal(empty.calls.length, 0);

  // Consented text exists: the model sees exactly those lines, and a recall
  // answer may quote them without being dropped as an echo.
  const start = 1_000_000_000_000;
  const seen = [];
  const withText = cues({ start, history: (nodeId, consentId, windowMs) => { seen.push({ nodeId, consentId, windowMs }); return { available: true, segments: [{ at: start - 300_000, endAt: start - 290_000, text: "Let's move the launch to Thursday." }] }; },
    replies: [cue("About 5 minutes ago you discussed moving the launch to Thursday.", "Earlier", "context")] });
  const recalled = await ask(withText.live, "What did we talk about five minutes ago?");
  assert.match(recalled.cue.brief, /launch to Thursday/);
  assert.deepEqual(seen, [{ nodeId: "node", consentId: "grant-1", windowMs: 20 * 60_000 }]);
  const input = JSON.parse(withText.calls[0].input);
  assert.deepEqual(input.recentConversation, [{ at: new Date(start - 300_000).toISOString(), text: "Let's move the launch to Thursday." }]);
  assert.match(withText.calls[0].instructions, /answer only from those timestamped lines/);
});

test("main returns recent Lifelog text only for the consent that is current", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-g2-history-"));
  let now = 1_000_000_000_000;
  const proactive = new G2Proactive({ dir, dataDir: dir, runtime: {}, now: () => now });
  try {
    assert.deepEqual(proactive.recentHistory("node", "none"), { available: false });
    const { consent } = proactive.dispatch("node", { op: "consent", enabled: true, recordingConsent: true });
    proactive.dispatch("node", { op: "capture", consentId: consent.id, batchId: "batch-0000000000000001", texts: ["Old topic from an hour ago."] });
    now += 45 * 60_000;
    proactive.dispatch("node", { op: "capture", consentId: consent.id, batchId: "batch-0000000000000002", texts: ["Let's move the launch to Thursday."] });
    const recent = proactive.recentHistory("node", consent.id);
    assert.equal(recent.available, true);
    assert.deepEqual(recent.segments.map(s => s.text), ["Let's move the launch to Thursday."]);
    assert.deepEqual(proactive.recentHistory("node", "someone-elses-grant"), { available: false });
    proactive.dispatch("node", { op: "consent", enabled: false, consentId: consent.id });
    assert.deepEqual(proactive.recentHistory("node", consent.id), { available: false }, "a withdrawn consent is never used");
  } finally { proactive.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
