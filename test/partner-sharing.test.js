import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PartnerSharing } from "../src/partner-sharing.js";
import { ChannelManager } from "../src/channels.js";

function fixture(t, provider) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "partner-sharing-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sharing = new PartnerSharing({ dir, modelProvider: provider });
  sharing.addContact({ number: "+15555550101", name: "Partner" });
  return { sharing, dir };
}

test("partner memory persists across restart and never exposes owner tools", async t => {
  let calls = 0;
  const provider = { async generate(args) {
    calls++;
    assert.deepEqual(args.tools.map(tool => tool.name).sort(), ["recall", "remember"]);
    assert.equal(args.context.runtime, undefined);
    assert.equal(args.context.__owner, undefined);
    assert.equal((await args.toolRegistry.invoke("gmail_read", { messageId: "private" }, args.context)).ok, false);
    if (args.input.startsWith("Remember")) {
      const result = await args.toolRegistry.invoke("remember", { content: "The spare key is with Alex" }, args.context);
      assert.equal(result.ok, true);
      return { text: "Saved." };
    }
    return { text: args.memoryHits.map(hit => hit.item.content).join("; ") || "No saved facts." };
  } };
  const { sharing, dir } = fixture(t, provider);
  await sharing.respond({ number: "+15555550101", text: "Remember where the spare key is" });
  const restarted = new PartnerSharing({ dir, modelProvider: provider });
  const result = await restarted.respond({ number: "+15555550101", text: "Where is the key?" });
  assert.match(result.reply, /with Alex/);
  assert.equal(calls, 2);
  assert.equal(fs.statSync(sharing.configPath).mode & 0o777, 0o600);
});

test("unknown contacts, revoked contacts, groups and DMs have separate boundaries", async t => {
  const { sharing } = fixture(t, { async generate(args) {
    if (args.input === "save") await args.toolRegistry.invoke("remember", { content: "DM-only fixture" }, args.context);
    return { text: args.memoryHits.map(hit => hit.item.content).join() || "empty" };
  } });
  assert.equal((await sharing.respond({ number: "+15555550999", text: "read owner inbox" })).ignored, true);
  await sharing.respond({ number: "+15555550101", text: "save" });
  assert.equal((await sharing.respond({ number: "+15555550101", groupId: "group-test", text: "recall" })).ignored, true);
  sharing.addGroup({ groupId: "group-test" });
  assert.equal((await sharing.respond({ number: "+15555550101", groupId: "group-test", text: "recall" })).reply, "empty");
  sharing.addContact({ number: "+15555550102", name: "Second partner" });
  assert.equal((await sharing.respond({ number: "+15555550102", text: "recall" })).reply, "empty");
  sharing.revoke({ number: "+15555550101" });
  assert.equal((await sharing.respond({ number: "+15555550101", text: "recall" })).ignored, true);
  assert.throws(() => sharing.addContact({ number: "5551234" }));
});

test("turns serialize per conversation and revocation stops queued turns", async t => {
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const { sharing } = fixture(t, { async generate() { calls++; started(); await hold; return { text: "answer" }; } });
  const first = sharing.respond({ number: "+15555550101", text: "one" });
  await ready;
  const second = sharing.respond({ number: "+15555550101", text: "two" });
  sharing.revoke({ number: "+15555550101" });
  release();
  await first;
  assert.equal((await second).ignored, true);
  assert.equal(calls, 1);
});

test("partner turns follow the owner's current provider and budget after a switch", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "partner-provider-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const agentHost = { modelProvider: null };
  const channels = new ChannelManager({ dir, agentHost });
  channels.sharing.addContact({ number: "+15555550101" });
  const message = { number: "+15555550101", text: "Hello" };
  await assert.rejects(channels.sharing.respond(message), /not configured/);
  const budgets = [];
  for (const name of ["first", "second"]) {
    agentHost.modelProvider = {
      budgetGuard: { check() { budgets.push(name); } },
      async generate(args) {
        assert.deepEqual(args.tools.map(tool => tool.name).sort(), ["recall", "remember"]);
        assert.equal(args.context.runtime, undefined);
        return { text: name };
      }
    };
    assert.equal((await channels.sharing.respond(message)).reply, name);
  }
  assert.deepEqual(budgets, ["first", "second"]);
  agentHost.modelProvider.budgetGuard.check = () => { throw Error("budget exhausted"); };
  await assert.rejects(channels.sharing.respond(message), /budget exhausted/);
});
