// Proactive iMessage extraction: links (regex), follow-ups → tasks, events →
// memory, with a date cursor so each message is processed once.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { IMessageExtractor } from "../src/imessage-extractor.js";

function makeRuntime({ messages = [], llm = '{"followups":[],"events":[]}' } = {}) {
  const items = new Map();
  let n = 0;
  for (const m of messages) {
    const id = `mem_${++n}`;
    items.set(id, { id, content: m.content, tags: m.tags ?? ["imessage", m.from ?? "+1555"], createdAt: m.createdAt });
  }
  const remembered = [];
  const tasks = [];
  const runtime = {
    memory: {
      items,
      remember: (obs, ctx) => { remembered.push({ content: obs.content, tags: obs.tags, tier: ctx?.tier }); return { id: `new_${remembered.length}` }; }
    },
    agentHost: {
      modelProvider: { isConfigured: () => true, generate: async () => ({ text: llm }) }
    },
    tasks: { add: (input, opts) => tasks.push({ input, opts }) }
  };
  return { runtime, remembered, tasks };
}

const dataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "openagi-imx-"));

test("extracts links via regex and saves them to memory (no model needed)", async () => {
  const { runtime, remembered } = makeRuntime({
    messages: [
      { content: "iMessage from +1555: check this https://example.com/deal and https://foo.bar/x", createdAt: "2026-06-12T10:00:00Z" }
    ],
    llm: '{"followups":[],"events":[]}'
  });
  const x = new IMessageExtractor({ runtime, dataDir: dataDir() });
  const r = await x.extract();
  assert.equal(r.links, 2, "both URLs saved");
  const links = remembered.filter((m) => m.tags.includes("link"));
  assert.equal(links.length, 2);
  assert.match(links[0].content, /https:\/\/example\.com\/deal/);
});

test("follow-ups become tasks; events become memory", async () => {
  const { runtime, remembered, tasks } = makeRuntime({
    messages: [
      { content: "iMessage from Sarah: can you send me the deck before Friday?", createdAt: "2026-06-12T11:00:00Z" },
      { content: "iMessage from Mom: dinner Sunday at 6 at our place", createdAt: "2026-06-12T11:01:00Z" }
    ],
    llm: JSON.stringify({
      followups: [{ text: "Send Sarah the deck before Friday", who: "Sarah" }],
      events: [{ title: "Dinner at Mom's", when: "Sunday 6pm" }]
    })
  });
  const x = new IMessageExtractor({ runtime, dataDir: dataDir() });
  const r = await x.extract();
  assert.equal(r.followups, 1, "one task created");
  assert.equal(tasks[0].input.title, "Send Sarah the deck before Friday");
  assert.equal(tasks[0].opts.source, "imessage");
  assert.equal(r.events, 1, "one event saved to memory");
  assert.ok(remembered.some((m) => m.tags.includes("event") && /Dinner at Mom/.test(m.content)));
});

test("idle: no new messages → skipped, $0", async () => {
  const { runtime } = makeRuntime({ messages: [] });
  const x = new IMessageExtractor({ runtime, dataDir: dataDir() });
  const r = await x.extract();
  assert.equal(r.skipped, true);
});

test("date cursor: a message is only processed once across runs", async () => {
  const dir = dataDir();
  const { runtime } = makeRuntime({
    messages: [{ content: "iMessage from +1555: https://once.example", createdAt: "2026-06-12T12:00:00Z" }]
  });
  const x = new IMessageExtractor({ runtime, dataDir: dir });
  const r1 = await x.extract();
  assert.equal(r1.links, 1, "first run processes it");
  const r2 = await x.extract();
  assert.equal(r2.skipped, true, "second run finds nothing new (cursor advanced)");
});

test("non-imessage memory items are ignored", async () => {
  const { runtime, remembered } = makeRuntime({
    messages: [
      { content: "a normal note", tags: ["note"], createdAt: "2026-06-12T13:00:00Z" },
      { content: "iMessage from +1555: https://keep.example", tags: ["imessage", "+1555"], createdAt: "2026-06-12T13:01:00Z" }
    ]
  });
  const x = new IMessageExtractor({ runtime, dataDir: dataDir() });
  const r = await x.extract();
  assert.equal(r.processed, 1, "only the imessage-tagged item is in the batch");
  assert.equal(r.links, 1);
});
