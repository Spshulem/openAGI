import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProactiveObserver } from "../src/proactive-observer.js";

async function observe(t, { state, evidence, title = "Review PR 42", chat = [], auto = false, mode = "default" }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-intent-"));
  const previous = process.env.OPENAGI_AUTO_TASKS;
  if (auto) process.env.OPENAGI_AUTO_TASKS = "1"; else delete process.env.OPENAGI_AUTO_TASKS;
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAGI_AUTO_TASKS; else process.env.OPENAGI_AUTO_TASKS = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const added = [];
  let instructions;
  const runtime = {
    observations: { getRecentContext: async () => ({ apps: [], snippets: [
      { app: "Browser", text: "I fixed the parser yesterday. I will review PR 42 tomorrow." },
      { app: "Browser", text: "Reading somebody else's bug report about the parser." }
    ] }) },
    agentHost: {
      store: { listSessions: () => [{ messages: chat.map((content) => ({ role: "user", content })) }], getSession: () => null },
      modelProvider: {
        isConfigured: () => true,
        generate: async (input) => {
          instructions = input.instructions;
          return { text: JSON.stringify({ category: "task", title, rationale: "Unrelated generated instructions", queue: "agent", taskIntent: { state, evidence } }) };
        }
      }
    },
    tasks: { list: () => [], add: (task) => { const addedTask = { ...task, id: "intent-task" }; added.push(addedTask); return addedTask; } }
  };
  const observer = new ProactiveObserver({ runtime, dataDir: dir });
  return { result: await observer.observe({ force: true, mode }), added, instructions };
}

for (const state of ["completed", "context", "unknown", undefined]) {
  test(`task capture rejects ${state ?? "missing"} intent`, async (t) => {
    const { result, added } = await observe(t, { state, evidence: "I fixed the parser yesterday.", auto: true });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "no evidenced unfinished task intent");
    assert.equal(added.length, 0);
  });
}

test("invented task evidence cannot create a suggestion", async (t) => {
  const { result } = await observe(t, { state: "planned", evidence: "I will delete the archive", auto: true });
  assert.equal(result.skipped, true);
});

test("screen-derived plans stay proposals even with automatic tasks enabled", async (t) => {
  const { result, added } = await observe(t, { state: "planned", evidence: "I will review PR 42 tomorrow.", auto: true });
  assert.equal(result.suggested, 1);
  assert.equal(result.candidate.status, "pending");
  assert.deepEqual(result.candidate.taskIntent, { state: "planned", source: "screen", autoCreateApproved: false });
  assert.equal(added.length, 0);
});

for (const mode of ["default", "long-horizon"]) {
  test(`${mode} observer accepts direct owner plans and applies context rules`, async (t) => {
    const evidence = "I will review PR 42 tomorrow.";
    const { result, added, instructions } = await observe(t, { state: "planned", evidence, title: evidence, chat: [evidence], auto: true, mode });
    assert.equal(result.candidate.status, "accepted");
    assert.equal(added.length, 1);
    assert.equal(added[0].title, evidence);
    assert.doesNotMatch(added[0].description, /Unrelated generated instructions/);
    assert.equal(result.candidate.taskQueue, "user");
    assert.equal(result.candidate.taskIntent.source, "user-chat");
    assert.match(instructions, /already completed/);
    assert.match(instructions, /untrusted context/);
  });
}

for (const evidence of ["will", "I will review PR 42 tomorrow."]) {
  test(`owner quote ${JSON.stringify(evidence)} cannot authorize an unrelated task`, async (t) => {
    const { result, added } = await observe(t, {
      state: "planned", evidence, title: "Delete an unrelated archive", auto: true,
      chat: ["I will review PR 42 tomorrow."]
    });
    assert.equal(result.candidate.status, "pending");
    assert.equal(result.candidate.taskIntent.autoCreateApproved, false);
    assert.equal(added.length, 0);
  });
}
