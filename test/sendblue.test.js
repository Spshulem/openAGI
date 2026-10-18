import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PartnerSharing } from "../src/partner-sharing.js";
import { SendblueChannel, matchesSecret } from "../src/integrations/sendblue.js";

const membership = (groupId, members) => Response.json({ status: "OK", data: {
  group_id: groupId,
  participant_numbers: members.filter(member => member.startsWith("+")),
  participants: members.map(handle => ({ handle }))
} });

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
  const f = fixture(t, async (url, init) => {
    if (init.method === "GET") return membership("group-fixture", [f.body.from_number, f.body.to_number]);
    sends.push({ url, body: JSON.parse(init.body) }); return Response.json({ status: "QUEUED" });
  });
  const body = { ...f.body, group_id: "group-fixture", participants: [f.body.from_number, f.body.to_number] };
  assert.equal((await f.channel.handleWebhook(body)).ignored, true);
  f.sharing.addGroup({ groupId: "group-fixture" });
  assert.equal((await f.channel.handleWebhook({ ...body, participants: [...body.participants, "+15555550999"] })).reason, "unapproved-group-member");
  assert.equal((await f.channel.handleWebhook(body)).accepted, true);
  assert.match(sends[0].url, /send-group-message$/);
  assert.equal(sends[0].body.group_id, "group-fixture");
  await assert.rejects(f.channel.sendMessage("+15555550999", "private"), /not approved/);
});

test("proactive group sends verify complete current membership, including email-only participants", async t => {
  let members = ["+15555550100", "+15555550101"], sends = 0, reads = 0;
  const f = fixture(t, async (url, init) => {
    if (init.method === "GET") {
      reads++;
      assert.equal(url, "https://api.sendblue.co/api/v2/groups/group-fixture");
      assert.equal(init.redirect, "error");
      assert.equal(init.headers["sb-api-key-id"], "fixture-key");
      return membership("group-fixture", members);
    }
    sends++; return Response.json({ status: "QUEUED" });
  });
  f.sharing.addGroup({ groupId: "group-fixture" });
  assert.equal((await f.channel.sendMessage("group-fixture", "Group fact", { group: true })).accepted, true);
  for (const extra of ["+15555550999", "unapproved@example.com"]) {
    members = [f.body.to_number, f.body.from_number, extra];
    await assert.rejects(f.channel.sendMessage("group-fixture", "Group fact", { group: true }), /membership/);
  }
  assert.equal(reads, 3); assert.equal(sends, 1); assert.equal(f.turns, 0);
});

test("group sends fail closed when complete membership cannot be verified", async t => {
  let response, sends = 0;
  const f = fixture(t, async (_url, init) => {
    if (init.method === "GET") return response();
    sends++; return Response.json({ status: "QUEUED" });
  });
  f.sharing.addGroup({ groupId: "group-fixture" });
  for (const payload of [
    { status: "OK", data: { group_id: "group-fixture", participant_numbers: [f.body.from_number] } },
    { status: "OK", data: { group_id: "other-group", participants: [{ handle: f.body.from_number }] } },
    { status: "OK", data: { group_id: "group-fixture", participants: [] } },
    { status: "OK", data: { group_id: "group-fixture", participants: [{}] } },
    { status: "ERROR" }
  ]) {
    response = () => Response.json(payload);
    await assert.rejects(f.channel.sendMessage("group-fixture", "Group fact", { group: true }), /membership/);
  }
  response = () => new Response("Unavailable", { status: 503 });
  await assert.rejects(f.channel.sendMessage("group-fixture", "Group fact", { group: true }), /verify Sendblue/);
  response = () => { throw Error("fixture membership timeout"); };
  await assert.rejects(f.channel.sendMessage("group-fixture", "Group fact", { group: true }), /timeout/);
  assert.equal(sends, 0);
});

test("group membership changes during generation block delivery and leave the reply retryable after repair", async t => {
  const members = ["+15555550100", "+15555550101"];
  let sends = 0;
  const f = fixture(t, async (_url, init) => {
    if (init.method === "GET") return membership("group-fixture", members);
    sends++; return Response.json({ status: "QUEUED" });
  });
  f.sharing.addGroup({ groupId: "group-fixture" });
  const generate = f.sharing.modelProvider.generate;
  f.sharing.modelProvider.generate = async args => {
    const result = await generate(args);
    members.push("+15555550999");
    return result;
  };
  const body = { ...f.body, group_id: "group-fixture", participants: members.slice() };
  await assert.rejects(f.channel.handleWebhook(body), /membership/);
  const receiptPath = path.join(f.channel.dir, fs.readdirSync(f.channel.dir)[0]);
  assert.equal(JSON.parse(fs.readFileSync(receiptPath)).sendStarted, undefined);
  assert.equal(sends, 0);
  members.pop();
  const restarted = new SendblueChannel({ sharing: f.sharing, env: f.channel.env, dir: f.channel.dir, fetchImpl: f.channel.fetchImpl });
  assert.equal((await restarted.handleWebhook(body)).accepted, true);
  assert.equal(sends, 1); assert.equal(f.turns, 1);
});

test("group approval revoked during membership lookup blocks the outbound send", async t => {
  let sends = 0;
  const f = fixture(t, async (_url, init) => {
    if (init.method === "GET") {
      f.sharing.revoke({ groupId: "group-fixture" });
      return membership("group-fixture", [f.body.to_number, f.body.from_number]);
    }
    sends++; return Response.json({ status: "QUEUED" });
  });
  f.sharing.addGroup({ groupId: "group-fixture" });
  await assert.rejects(f.channel.sendMessage("group-fixture", "Group fact", { group: true }), /not approved/);
  assert.equal(sends, 0);
});
