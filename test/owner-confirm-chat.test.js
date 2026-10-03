// The owner's spoken "yes" / "yes NN" / "no NN" runs or drops a pending card
// before the model sees the turn. Only an owner principal can do it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentHost } from "../src/agent-host.js";
import { ToolRegistry } from "../src/tool-registry.js";
import { PendingActionStore } from "../src/pending-actions.js";
import { G2Channel } from "../src/integrations/g2-channel.js";
import { isOwnerPrincipal, ownerPrincipal } from "../src/owner-authority.js";

function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-owner-confirm-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let code = 20;
  const pendingActions = new PendingActionStore({ dir, randomInt: () => code++ });
  const tools = new ToolRegistry();
  tools.bindPendingActions(pendingActions);
  const ran = [];
  tools.register({ name: "fleet_click", needsConfirmation: true, summarize: (args) => `Click ${args.label}`,
    handler: async (args, context) => { ran.push({ args, approvedBy: context.__approvedBy }); return { clicked: args.label }; } });
  const turns = [];
  const runtime = {
    tools, pendingActions,
    memory: { remember: () => ({ id: "m" }) },
    outcomes: null,
    processSignal: () => ({ id: "out", scrutiny: { action: "ask", score: 0.3, reasons: [], dimensions: { novelty: 0.3, risk: 0.3, repetition: 0.3 } }, customContext: [], propagation: {} })
  };
  const host = new AgentHost({ runtime, modelProvider: { isConfigured: () => true, model: "stub",
    generate: async (request) => { turns.push(request); return { text: "ok", provider: "stub", model: "stub", toolCalls: [] }; } } });
  const say = (text, sessionId = "chat-a", principal = ownerPrincipal("g2", "g2-1")) =>
    host.handleMessage({ text, sessionId, channel: "g2", from: "node:g2" }, { principal });
  const card = (sessionId, label) => pendingActions.enqueue({ toolName: "fleet_click", args: { label }, context: { sessionId }, summary: `Click ${label}`, mode: "chat", announce: false });
  return { pendingActions, ran, turns, say, card, host };
}

test("a bare yes runs the one card this chat raised since the owner last spoke", async (t) => {
  const h = harness(t);
  await h.say("what does the openagi thread need?");
  const raised = h.card("chat-a", "Allow");
  await h.say("Yes. Please approve that");
  assert.deepEqual(h.ran, [{ args: { label: "Allow" }, approvedBy: "owner:g2" }]);
  const action = h.pendingActions.get(raised.id);
  assert.equal(action.status, "approved");
  assert.equal(action.decidedBy, "owner:g2");
  assert.match(h.turns.at(-1).turnContext, /Owner confirmation, already handled by OpenAGI/);
  assert.match(h.turns.at(-1).turnContext, /"status":"done"/);
  assert.match(h.turns.at(-1).turnContext, /Current decision: act \(owner instruction\)/);
});

test("yes NN runs that card from any session; no NN drops it", async (t) => {
  const h = harness(t);
  const elsewhere = h.card("devices:supervisor:main", "Run");
  const dropped = h.card("devices:agent:main", "Allow once");
  await h.say(`yes ${elsewhere.confirmCode}`, "local:user:main", ownerPrincipal("owner"));
  assert.deepEqual(h.ran, [{ args: { label: "Run" }, approvedBy: "owner:owner" }]);
  await h.say(`no ${dropped.confirmCode}`, "local:user:main", ownerPrincipal("phone", "p1"));
  assert.equal(h.pendingActions.get(dropped.id).status, "denied");
  assert.equal(h.pendingActions.get(dropped.id).decidedBy, "owner:phone");
  assert.equal(h.ran.length, 1);
  await h.say("yes 99", "local:user:main", ownerPrincipal("owner"));
  assert.match(h.turns.at(-1).turnContext, /no pending action has that code/);
});

test("two candidates, or a card from before the last message, fall through to the model", async (t) => {
  const h = harness(t);
  await h.say("hello");
  h.card("chat-a", "Allow");
  h.card("chat-a", "Deny");
  await h.say("yes");
  assert.equal(h.ran.length, 0, "ambiguous: nothing runs");
  assert.doesNotMatch(h.turns.at(-1).turnContext, /Owner confirmation/);

  const stale = harness(t);
  stale.card("chat-b", "Allow");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await stale.say("something else", "chat-b");
  await stale.say("yes", "chat-b");
  assert.equal(stale.ran.length, 0, "a card older than the previous message is stale");
});

test("no principal, a forged one, and the G2 listen path get nothing", async (t) => {
  const h = harness(t);
  const raised = h.card("chat-a", "Allow");
  await h.host.handleMessage({ text: `yes ${raised.confirmCode}`, sessionId: "chat-a", channel: "node", from: "imessage" });
  await h.host.handleMessage({ text: `yes ${raised.confirmCode}`, sessionId: "chat-a" }, { principal: { kind: "owner", via: "g2", nodeId: "x" } });
  assert.equal(h.ran.length, 0);
  assert.equal(h.pendingActions.get(raised.id).status, "pending");
  assert.match(h.turns.at(-1).turnContext, /Current decision: ask/);
  assert.equal(h.turns.at(-1).context.__owner, undefined);

  // G2: a tap (ask) is the owner; ambient wake listening is not.
  const seen = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-g2-principal-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const channel = new G2Channel({
    dir, apiKey: "test", fetchImpl: async () => ({ ok: true, json: async () => ({ text: `open agi yes ${raised.confirmCode}` }) }),
    nodeRegistry: { enrollment: () => ({ platform: "even_g2", name: "G2" }), touchEnrollment() {} },
    agentHost: { handleMessage: async (input, options) => { seen.push(options?.principal ?? null); return { reply: "ok", session: { id: input.sessionId } }; } }
  });
  const wav = Buffer.alloc(44 + 3_200);
  wav.write("RIFF", 0, "ascii"); wav.write("WAVE", 8, "ascii"); wav.write("fmt ", 12, "ascii");
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16_000, 24); wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii"); wav.writeUInt32LE(3_200, 40);
  await channel.listen({ audioBase64: wav.toString("base64"), conversationId: "conv-1" }, "g2-1");
  await channel.ask({ text: "yes", conversationId: "conv-1" }, "g2-1", { principal: null });
  assert.equal(seen[0], null, "listen never carries owner authority");
  assert.equal(isOwnerPrincipal(seen[1]), true, "a tap is the owner");
  assert.equal(seen[1].via, "g2");
  assert.equal(seen[1].nodeId, "g2-1");
});
