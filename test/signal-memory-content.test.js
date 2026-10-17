import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDefaultRuntime } from '../src/index.js';
import { HashBagEmbedder } from '../src/embeddings.js';

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openagi-signal-memory-'));
  const runtime = createDefaultRuntime({
    dataDir, observationOptions: { dir: path.join(dataDir, 'observations') },
    outcomeOptions: { dir: path.join(dataDir, 'outcomes') },
    vectorStoreOptions: { dir: path.join(dataDir, 'vectors') },
    embedder: new HashBagEmbedder(),
  });
  t.after(async () => {
    await runtime.sessionIndex.rebuildPromise;
    runtime.sessionIndex.db?.close();
    runtime.observations.db?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  runtime.scrutiny.evaluate = () => ({ action: 'observe', score: 0.6, reasons: ['retain useful evidence'], dimensions: {} });
  runtime.propagation.shouldPropagate = () => ({ decision: false });
  return runtime;
}
function signal(content) {
  return { id: 'synthetic-signal', source: 'synthetic-integration', summary: 'Project update', content,
    domain: 'general', taskType: 'update', tags: [], novelty: 0.6, risk: 0.2, repetition: 0.1 };
}

test('signal memory retains body and distinguishes facts sharing a summary', (t) => {
  const runtime = fixture(t);
  const first = runtime.processSignal(signal('Delivery moved to Tuesday.'));
  const second = runtime.processSignal(signal('Delivery moved to Friday.'));
  assert.match(first.memory.content, /Delivery moved to Tuesday\./);
  assert.match(second.memory.content, /Delivery moved to Friday\./);
  assert.notEqual(first.memory.id, second.memory.id);
  assert.equal(runtime.memory.snapshot().medium.length, 2);
});

test('summary-only signals retain a clean memory and exact repeats still deduplicate', (t) => {
  const runtime = fixture(t);
  const first = runtime.processSignal(signal(undefined));
  const second = runtime.processSignal(signal(undefined));
  assert.match(first.memory.content, /Project update/);
  assert.doesNotMatch(first.memory.content, /undefined|null/);
  assert.equal(first.memory.id, second.memory.id);
  const repeated = runtime.processSignal(signal('Delivery moved to Tuesday.'));
  assert.equal(runtime.processSignal(signal('Delivery moved to Tuesday.')).memory.id, repeated.memory.id);
});

test('ignored and ephemeral bodies are never committed to memory', (t) => {
  const runtime = fixture(t);
  assert.equal(runtime.processSignal(signal('Synthetic connectivity probe'), { ephemeral: true }).memory, null);
  runtime.scrutiny.evaluate = () => ({ action: 'ignore', score: 0, reasons: [], dimensions: {} });
  assert.equal(runtime.processSignal(signal('Synthetic low-signal noise')).memory, null);
  assert.equal(runtime.memory.items.size, 0);
});

test('normalized summary-only integration signals store text once and retain diagnostics', (t) => {
  const runtime = fixture(t);
  const summary = 'Synthetic status detail. '.repeat(14).trim();
  const [output] = runtime.processIntegrationEvent('abi', { ...signal(undefined), summary });
  assert.equal(output.signal.content, output.signal.summary, 'exercise normalized fallback');
  assert.equal(output.memory.content.split(summary).length - 1, 1);
  assert.match(output.memory.content, /Decision: observe/);
  assert.match(output.memory.content, /Reasons: retain useful evidence/);
});

test('long compressed memory retains distinct bodies behind a maximum-length summary', (t) => {
  const runtime = fixture(t);
  const summary = 'Synthetic repeated project context. '.repeat(20);
  const input = { ...signal('Delivery moved to Tuesday.'), summary, risk: 0.7, novelty: 0.6, specificity: 0.45 };
  const [first] = runtime.processIntegrationEvent('abi', input);
  const [second] = runtime.processIntegrationEvent('abi', { ...input, content: 'Delivery moved to Friday.' });
  assert.ok(first.signal.summary.length >= 500);
  assert.equal(first.memory.tier, 'long');
  assert.equal(first.memory.fidelity, 'compressed');
  assert.match(first.memory.content, /Delivery moved to Tuesday\./);
  assert.match(second.memory.content, /Delivery moved to Friday\./);
  assert.notEqual(first.memory.id, second.memory.id);
  assert.ok(first.memory.content.length <= 362);
  assert.equal(runtime.memory.retrieve('Tuesday', { limit: 1 })[0].item.id, first.memory.id);
});

for (const [label, summary] of [
  ['repeated whitespace', 'Synthetic   status\n\tdetail. '.repeat(16)],
  ['truncated summary', 'Synthetic status detail. '.repeat(29) + 'Final evidence.'],
]) {
  test(`summary fallback with ${label} retains diagnostics without duplication`, (t) => {
    const runtime = fixture(t);
    const [output] = runtime.processIntegrationEvent('abi', {
      ...signal(undefined), summary, risk: 0.1, novelty: 0.1, specificity: 0.45,
    });
    assert.equal(output.memory.tier, 'short');
    const body = summary.replace(/\s+/g, ' ').trim();
    assert.ok(output.memory.content.startsWith(body));
    assert.equal(output.memory.content.split('Synthetic status detail.').length - 1,
      body.split('Synthetic status detail.').length - 1);
    assert.match(output.memory.content, /Decision: observe/);
    assert.match(output.memory.content, /Reasons: retain useful evidence/);
  });
}

for (const [label, text] of [
  ['plain text', 'Synthetic project update with useful detail. '.repeat(9)],
  ['normalized whitespace', 'Synthetic   project update\nwith useful detail. '.repeat(9)],
]) {
  test(`chat prefix summary with ${label} retains body and diagnostics`, async (t) => {
    const runtime = fixture(t);
    const chatSignal = await runtime.agentHost.messageToSignal({
      text, channel: 'local', from: 'synthetic-owner', agent: { id: 'synthetic-agent' },
      sessionId: 'synthetic-session', metadata: {},
    });
    assert.equal(chatSignal.summary, text.slice(0, 240), 'exercise the actual chat summary path');
    const output = runtime.processSignal({ ...chatSignal, novelty: 0.6, risk: 0.2, specificity: 0.45 });
    assert.equal(output.memory.tier, 'medium');
    assert.equal(output.memory.fidelity, 'normal');
    const body = text.replace(/\s+/g, ' ').trim();
    assert.equal(output.memory.content,
      `${body} Decision: observe Reasons: retain useful evidence`);
  });
}

test('a distinct summary remains alongside body evidence', (t) => {
  const runtime = fixture(t);
  const output = runtime.processSignal(signal('Delivery moved to Tuesday.'));
  assert.match(output.memory.content, /Delivery moved to Tuesday\. Project update Decision: observe/);
});

for (const [kind, body] of [
  ['object', (day) => ({ delivery: day })],
  ['array', (day) => [{ delivery: day }, 'confirmed']],
]) {
  test(`structured ${kind} integration bodies retain distinct evidence`, (t) => {
    const runtime = fixture(t);
    const [first] = runtime.processIntegrationEvent('abi', signal(body('Tuesday')));
    const [second] = runtime.processIntegrationEvent('abi', signal(body('Friday')));
    assert.ok(first.memory.content.startsWith(JSON.stringify(body('Tuesday'))));
    assert.ok(second.memory.content.startsWith(JSON.stringify(body('Friday'))));
    assert.doesNotMatch(first.memory.content, /\[object Object\]/);
    assert.notEqual(first.memory.id, second.memory.id);
    const [repeated] = runtime.processIntegrationEvent('abi', signal(body('Tuesday')));
    assert.equal(repeated.memory.id, first.memory.id);
    assert.equal(runtime.memory.snapshot().medium.length, 2);
  });
}

test('fixture isolates persistent stores and uses offline embeddings', async (t) => {
  const runtime = fixture(t);
  assert.equal(runtime.embedder.name, 'hash-bag');
  assert.equal(path.dirname(runtime.outcomes.dir), path.dirname(runtime.observations.dir));
  assert.equal(path.dirname(runtime.vectorStore.dir), path.dirname(runtime.observations.dir));
  assert.equal(runtime.outcomes.outcomes.size, 0);
  assert.equal(runtime.vectorStore.entries.size, 0);
  await runtime.vectorStore.upsert('memory', 'fixture-only', 'Synthetic delivery evidence');
  assert.equal((await runtime.vectorStore.search('memory', 'delivery evidence'))[0].id, 'fixture-only');
});

for (const [kind, body] of [
  ['object', { material: 'zirconium' }],
  ['array', [{ material: 'zirconium' }]],
]) {
  test(`structured ${kind} evidence retrieves prior context before scrutiny`, (t) => {
    const runtime = fixture(t);
    const prior = runtime.memory.remember({ content: 'zirconium', tags: [], source: 'synthetic-evidence' });
    const unrelated = runtime.memory.remember({ content: 'unrelated', tags: [], source: 'synthetic-evidence' });
    let evaluatedMemories;
    runtime.scrutiny.evaluate = ({ memories }) => {
      evaluatedMemories = memories;
      return { action: 'observe', score: 0.6, reasons: ['retain useful evidence'], dimensions: {} };
    };
    const [output] = runtime.processIntegrationEvent('abi', signal(body));
    assert.ok(evaluatedMemories.some(({ item }) => item.id === prior.id), 'scrutiny must receive body-matched context');
    assert.ok(output.customContext.some(({ id }) => id === prior.id));
    assert.ok(!output.customContext.some(({ id }) => id === unrelated.id));
    assert.ok(output.memory.content.startsWith(JSON.stringify(body)));
  });
}

for (const body of [undefined, null]) {
  test(`missing ${body} body does not create an artificial recall match`, (t) => {
    const runtime = fixture(t);
    runtime.memory.remember({ content: String(body), tags: [], source: 'synthetic-evidence' });
    const output = runtime.processSignal(signal(body));
    assert.deepEqual(output.customContext, []);
    assert.match(output.memory.content, /Project update/);
  });
}
