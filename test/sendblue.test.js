import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PartnerSharing } from "../src/partner-sharing.js";
import { SendblueChannel, matchesSecret } from "../src/integrations/sendblue.js";

function fixture(t, fetchImpl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sendblue-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let turns = 0;
  const sharing = new PartnerSharing({ dir: path.join(dir, "sharing"), modelProvider: { async generate() { turns++; return { text: "Fixture answer" }; } } });
  sharing.addContact({ number: "+15555550101" });
  const env = { SENDBLUE_API_KEY: "fixture-key", SENDBLUE_API_SECRET: "fixture-secret", SENDBLUE_FROM_NUMBER: "+15555550100", SENDBLUE_WEBHOOK_SECRET: "fixture-webhook" };
  const channel = new SendblueChannel({ sharing, dir: path.join(dir, "receipts"), env, fetchImpl });
  const body = { is_outbound: false, from_number: "+15555550101", to_number: "+15555550100", message_handle: "fixture-message", content: "Hello" };
  return { channel, sharing, body, get turns() { return turns; } };
}
test("Sendblue secret fails closed and unknown senders/lines/echoes never invoke the model", async t => {
  const f = fixture(t, () => { throw Error("must not send"); });
  assert.equal(f.channel.verify("fixture-webhook"), true);
  assert.equal(matchesSecret("", ""), false);
  assert.equal(matchesSecret("wrong", "fixture-webhook"), false);
  for (const changes of [{ is_outbound: true }, { from_number: "+15555550999" }, { to_number: "+15555550199" }]) assert.equal((await f.channel.handleWebhook({ ...f.body, ...changes })).ignored, true);
  assert.equal(f.turns, 0);
});
test("duplicate and concurrent webhooks produce one model turn and one API send, with restart dedupe", async t => {
  const sends = [];
  const f = fixture(t, async (url, init) => { sends.push({ url, body: JSON.parse(init.body) }); return Response.json({ message_handle: "outgoing-fixture", status: "QUEUED" }); });
  const results = await Promise.all([f.channel.handleWebhook(f.body), f.channel.handleWebhook(f.body)]);
  assert.equal(results[0].accepted, true);
  assert.equal(results[0].delivered, undefined);
  assert.equal(f.turns, 1); assert.equal(sends.length, 1);
  assert.equal(sends[0].body.from_number, "+15555550100");
  const restarted = new SendblueChannel({ sharing: f.sharing, dir: f.channel.dir, env: f.channel.env, fetchImpl: () => { throw Error("must not resend"); } });
  assert.equal((await restarted.handleWebhook(f.body)).duplicate, true);
});
test("ambiguous sends are held for review rather than automatically repeated", async t => {
  let sends = 0;
  const f = fixture(t, async () => { sends++; throw Error("connection lost after request"); });
  await assert.rejects(f.channel.handleWebhook(f.body));
  const retry = await f.channel.handleWebhook(f.body);
  assert.equal(retry.requiresReview, true);
  assert.equal(f.turns, 1); assert.equal(sends, 1);
});

test("missing credentials leave the saved reply retryable after configuration and restart", async t => {
  let sends = 0;
  const f = fixture(t, async () => { sends++; return Response.json({ status: "QUEUED" }); });
  delete f.channel.env.SENDBLUE_API_KEY;
  await assert.rejects(f.channel.handleWebhook(f.body), /Configure Sendblue/);
  assert.equal(sends, 0);
  const receiptPath = path.join(f.channel.dir, fs.readdirSync(f.channel.dir)[0]);
  assert.equal(JSON.parse(fs.readFileSync(receiptPath)).sendStarted, undefined);
  f.channel.env.SENDBLUE_API_KEY = "repaired-fixture-key";
  const restarted = new SendblueChannel({ sharing: f.sharing, dir: f.channel.dir, env: f.channel.env, fetchImpl: f.channel.fetchImpl });
  assert.equal((await restarted.handleWebhook(f.body)).accepted, true);
  assert.equal(f.turns, 1); assert.equal(sends, 1);
});

test("oversized replies never mark a send as ambiguous or issue an HTTP request", async t => {
  const f = fixture(t, () => { throw Error("must not send"); });
  f.sharing.modelProvider.generate = async () => ({ text: "x".repeat(16001) });
  await assert.rejects(f.channel.handleWebhook(f.body), /1–16000/);
  await assert.rejects(f.channel.handleWebhook(f.body), /1–16000/);
  const receiptPath = path.join(f.channel.dir, fs.readdirSync(f.channel.dir)[0]);
  assert.equal(JSON.parse(fs.readFileSync(receiptPath)).sendStarted, undefined);
});
test("group replies require an approved group and approved membership", async t => {
  const sends = [];
  const f = fixture(t, async (url, init) => { sends.push({ url, body: JSON.parse(init.body) }); return Response.json({ status: "QUEUED" }); });
  const body = { ...f.body, group_id: "group-fixture", participants: [f.body.from_number, f.body.to_number] };
  assert.equal((await f.channel.handleWebhook(body)).ignored, true);
  f.sharing.addGroup({ groupId: "group-fixture" });
  assert.equal((await f.channel.handleWebhook({ ...body, participants: [...body.participants, "+15555550999"] })).reason, "unapproved-group-member");
  assert.equal((await f.channel.handleWebhook(body)).accepted, true);
  assert.match(sends[0].url, /send-group-message$/);
  assert.equal(sends[0].body.group_id, "group-fixture");
  await assert.rejects(f.channel.sendMessage("+15555550999", "private"), /not approved/);
});
