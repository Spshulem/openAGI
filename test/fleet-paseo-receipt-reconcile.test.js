// A pending Paseo receipt whose turn was never confirmed at send time is
// settled against the chat's whole timeline. Hosts that rebuild a timeline
// from provider history (Codex items, Antigravity "<id>:history:<n>") drop
// our client message ID and turn IDs, which left receipts from Nov 10-15
// refusing every later nudge with "Previous delivery has no confirmed turn".
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { PASEO_STATUS_CHECK_TEXT, deliverPaseo, reconcilePaseoReceipt } from "../src/fleet/paseo-delivery.js";
import { paseoThread } from "../src/fleet/sources/paseo.js";
import { shortHash } from "../src/fleet/contracts.js";
import { FleetStore } from "../src/fleet/store.js";

const OLD_TEXT = "[OpenAGI supervisor] Inspect the existing CI rerun for commit 06f4793 and continue the authorized work.";
const NEW_TEXT = "[OpenAGI supervisor] Check the finished run and report.";
const HOURS_AGO = (h) => new Date(Date.now() - h * 3600_000).toISOString();

// A host timeline with real paging: tail, before(cursor), after(cursor).
function setup(t, { history = [], agent: agentExtra = {}, epoch = "epoch-now", replyToSends = true, hostOnline = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-reconcile-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const initial = { id: "chat", status: "idle", updatedAt: "2026-11-23T06:00:00Z", cwd: "/workspace/repo", workspaceId: "workspace" };
  let current = { ...initial, ...agentExtra };
  const entries = history.map((entry, i) => ({ ...entry, seqStart: i + 1, seqEnd: i + 1 }));
  const sent = [];
  const reads = [];
  const page = (list, hasOlder) => ({
    epoch,
    agent: current,
    entries: list,
    hasOlder,
    hasNewer: false,
    startCursor: list[0] ? { epoch, seq: list[0].seqStart } : null,
    endCursor: list.at(-1) ? { epoch, seq: list.at(-1).seqEnd } : null,
  });
  const ref = {
    refresh: async () => {},
    current: () => current,
    send: async (text, options) => {
      sent.push({ text, options });
      const seq = entries.length + 1;
      entries.push({ item: { type: "user_message", text, clientMessageId: options.messageId }, turnId: `turn-${seq}`, seqStart: seq, seqEnd: seq });
      if (replyToSends) entries.push({ item: { type: "assistant_message", text: "Stopped after the CI check." }, turnId: `turn-${seq}`, seqStart: seq + 1, seqEnd: seq + 1 });
    },
    timeline: {
      refetch: async (options = {}) => {
        reads.push(options);
        const limit = options.limit ?? 40;
        if (options.direction === "after") {
          if (options.cursor?.epoch !== epoch) return { ...page([], false), epoch };
          return page(entries.filter((e) => e.seqStart > options.cursor.seq).slice(0, limit), false);
        }
        const upTo = options.direction === "before" ? entries.filter((e) => e.seqStart < options.cursor.seq) : entries;
        const slice = upTo.slice(Math.max(0, upTo.length - limit));
        return page(slice, upTo.length > slice.length);
      },
    },
  };
  const factory = () => ({
    connect: async () => {},
    close: async () => {},
    hosts: { list: async () => (hostOnline ? { self: { serverId: "host" }, hosts: [] } : { self: { serverId: "other" }, hosts: [{ serverId: "host", enabled: true, status: "offline" }] }) },
    agents: { ref: () => ref },
  });
  const thread = paseoThread(initial, "host");
  const file = path.join(dir, "paseo-deliveries", `${createHash("sha256").update(thread.key).digest("hex")}.json`);
  const writeReceipt = (receipt) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(receipt)); };
  const readReceipt = () => JSON.parse(fs.readFileSync(file, "utf8"));
  const args = { config: { paseo: { enabled: true } }, thread, text: NEW_TEXT, store: { dir }, actionId: "action", base: { playbook: "status-check", messageHash: shortHash(NEW_TEXT) }, factory };
  return { sent, reads, ref, args, writeReceipt, readReceipt, setAgent: (extra) => { current = { ...current, ...extra }; } };
}

// A stale receipt as the Mac holds them: a client ID the host never kept, a
// cursor from a projection epoch that no longer exists, still pending.
const staleReceipt = (extra = {}) => ({
  messageId: "05665e6c-949f-4fb1-800a-96abcbe1eb40",
  clientMessageId: "05665e6c-949f-4fb1-800a-96abcbe1eb40",
  messageHash: shortHash(OLD_TEXT),
  activityAt: HOURS_AGO(240),
  cursor: { epoch: "epoch-gone", seq: 1099511627837 },
  pending: true,
  ...extra,
});

const filler = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ item: { type: i % 2 ? "assistant_message" : "tool_call", text: `work ${from + i}` } }));
const providerUser = (text, id = "6c440a1e-3bbb-4fa9-90bb-e2ecdb56b711") => ({ item: { type: "user_message", text, messageId: id } });
const reply = (text = "Everything passed on 06f4793.") => ({ item: { type: "assistant_message", text } });

test("(a) lost acknowledgment: the message is deep in a rebuilt timeline with a reply, so it settles as delivered and the next nudge goes out", async (t) => {
  const f = setup(t, { history: [...filler(30), providerUser(OLD_TEXT), filler(3)[0], reply(), ...filler(450, 100)] });
  f.writeReceipt(staleReceipt());
  const first = await deliverPaseo(f.args);
  assert.equal(first.status, "blocked");
  assert.match(first.detail, /^Previous nudge was delivered \(answered; matched by message-hash in the Paseo timeline\)/);
  assert.equal(f.sent.length, 0, "settling never sends");
  const saved = f.readReceipt();
  assert.equal(saved.pending, false);
  assert.equal(saved.reconciled.outcome, "delivered");
  assert.equal(saved.reconciled.by, "message-hash");
  assert.equal(saved.reconciled.entryId, "6c440a1e-3bbb-4fa9-90bb-e2ecdb56b711");
  assert.equal(saved.reconciled.replied, true);
  assert.ok(f.reads.some((r) => r.direction === "before"), "paged past the 40-entry tail");
  // The chat is no longer bricked: the next proposal is delivered normally.
  const next = await deliverPaseo({ ...f.args, actionId: "next" });
  assert.equal(next.status, "sent");
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].text, NEW_TEXT);
});

test("(a) an exact client ID kept by the host settles the receipt too", async (t) => {
  const f = setup(t, { history: [{ item: { type: "user_message", text: "edited", clientMessageId: "05665e6c-949f-4fb1-800a-96abcbe1eb40" } }, reply(), ...filler(300)] });
  f.writeReceipt(staleReceipt());
  const result = await deliverPaseo(f.args);
  assert.match(result.detail, /matched by message-id/);
  assert.equal(f.readReceipt().pending, false);
  assert.equal(f.sent.length, 0);
});

test("(a) a delivered message whose turn failed settles as delivered with the failure, not as undeliverable", async (t) => {
  const f = setup(t, { history: [providerUser(OLD_TEXT), reply("[System Error] Codex runtime exited")] });
  f.writeReceipt(staleReceipt());
  const result = await deliverPaseo(f.args);
  assert.match(result.detail, /^Previous nudge was delivered; its turn then failed \(\[System Error\] Codex runtime exited\)/);
  assert.equal(f.readReceipt().reconciled.executionError, "[System Error] Codex runtime exited");
  assert.equal(f.sent.length, 0);
});

test("(b) already started: the message is the newest entry and its turn is running, so it settles without a resend", async (t) => {
  const f = setup(t, { history: [...filler(10), providerUser(OLD_TEXT)], agent: { status: "running", activeTurn: { turnId: "t-run" } } });
  f.writeReceipt(staleReceipt());
  const result = await deliverPaseo(f.args);
  assert.match(result.detail, /^Previous nudge was delivered \(its turn is running;/);
  assert.equal(f.readReceipt().reconciled.outcome, "running");
  assert.equal(f.sent.length, 0);
});

test("(c) persistently ambiguous and safely idle: exactly one status check, never the old message, never the new proposal", async (t) => {
  const f = setup(t, { history: filler(120) });
  f.writeReceipt(staleReceipt());
  const first = await deliverPaseo(f.args);
  assert.equal(first.status, "blocked");
  assert.equal(first.statusCheck, true);
  assert.match(first.detail, /^Sent one status check after an unconfirmable earlier delivery \(no replay\)/);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].text, PASEO_STATUS_CHECK_TEXT);
  assert.notEqual(f.sent[0].text, OLD_TEXT);
  const saved = f.readReceipt();
  assert.equal(saved.pending, false, "the status check's own turn was confirmed");
  assert.deepEqual(saved.statusCheck, { messageId: "05665e6c-949f-4fb1-800a-96abcbe1eb40", outcome: "ambiguous" });
  assert.equal(saved.messageHash, shortHash(PASEO_STATUS_CHECK_TEXT));
});

test("(c) a status check that is itself unconfirmed is never repeated; the chat is held as a session error", async (t) => {
  const f = setup(t, { history: filler(20), replyToSends: false });
  f.writeReceipt(staleReceipt());
  const first = await deliverPaseo(f.args);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].text, PASEO_STATUS_CHECK_TEXT);
  assert.match(first.detail, /turn start unconfirmed/);
  // Make the status check's own message unfindable (as a rebuilt timeline would).
  const pendingCheck = f.readReceipt();
  assert.equal(pendingCheck.pending, true);
  f.writeReceipt({ ...pendingCheck, messageId: "lost", clientMessageId: "lost", messageHash: "0000000000000000", sentAt: HOURS_AGO(2) });
  for (let i = 0; i < 3; i++) {
    const again = await deliverPaseo({ ...f.args, actionId: `again-${i}` });
    assert.equal(again.status, "blocked");
    assert.match(again.detail, /^Previous delivery and its one status check are both unconfirmed; held, no automatic resend/);
  }
  assert.equal(f.sent.length, 1, "one status check per ambiguous receipt, ever");
  // Not benign: it builds the session-error streak the owner sees.
  const store = new FleetStore({ dir: path.join(f.args.store.dir, "ledger") });
  store.recordNudge("k", { status: "blocked", detail: "Previous delivery and its one status check are both unconfirmed; held, no automatic resend" });
  assert.ok(store.ledgerFor("k").undelivered);
});

test("(c) a message that landed with no reply and nothing running also gets only the one status check", async (t) => {
  const f = setup(t, { history: [...filler(5), providerUser(OLD_TEXT)] });
  f.writeReceipt(staleReceipt());
  const result = await deliverPaseo(f.args);
  assert.equal(result.statusCheck, true);
  assert.equal(f.readReceipt().statusCheck.outcome, "unanswered");
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].text, PASEO_STATUS_CHECK_TEXT);
});

for (const [name, agent, why] of [
  ["pending permission", { pendingPermissions: [{ id: "p1" }] }, /requires owner permission/],
  ["errored chat", { status: "error" }, /stopped on an error/],
  ["running turn", { status: "running", activeTurn: { turnId: "x" } }, /active, closed, or unavailable/],
]) {
  test(`(c) ambiguous but not safe (${name}): held for the status check, nothing sent`, async (t) => {
    const f = setup(t, { history: filler(50), agent });
    f.writeReceipt(staleReceipt());
    const result = await deliverPaseo(f.args);
    assert.equal(result.status, "blocked");
    assert.match(result.detail, /^Previous delivery has no confirmed turn; holding its one status check until the chat is idle \(/);
    assert.match(result.detail, why);
    assert.equal(f.sent.length, 0);
    assert.equal(f.readReceipt().pending, true, "the receipt stays pending until the check can run");
  });
}

test("(c) a young unconfirmed receipt is not status-checked yet: age is a wait, never evidence", async (t) => {
  const f = setup(t, { history: filler(50) });
  f.writeReceipt(staleReceipt({ activityAt: HOURS_AGO(0.1), sentAt: HOURS_AGO(0.1) }));
  const result = await deliverPaseo(f.args);
  assert.equal(result.detail, "Previous delivery has no confirmed turn; no automatic resend");
  assert.equal(f.sent.length, 0);
  assert.equal(f.readReceipt().pending, true);
});

test("(c) the same text sent before this receipt's cursor is another send, not evidence", async (t) => {
  const history = [providerUser(OLD_TEXT, "earlier-send"), reply(), ...filler(10)];
  const f = setup(t, { history, epoch: "epoch-same" });
  f.writeReceipt(staleReceipt({ cursor: { epoch: "epoch-same", seq: 5 } }));
  const result = await deliverPaseo(f.args);
  assert.notEqual(f.readReceipt().reconciled?.outcome, "delivered");
  assert.equal(result.statusCheck, true);
});

test("(d) an unreachable host is named, nothing is sent, and the receipt is untouched", async (t) => {
  const f = setup(t, { history: filler(5), hostOnline: false });
  f.writeReceipt(staleReceipt());
  const result = await deliverPaseo(f.args);
  assert.equal(result.status, "blocked");
  assert.match(result.detail, /Paseo host unavailable/);
  assert.equal(f.sent.length, 0);
  assert.equal(f.readReceipt().pending, true);
});

test("(d) a timeline the host cannot serve is named, nothing is sent", async (t) => {
  const f = setup(t, { history: filler(5) });
  f.writeReceipt(staleReceipt());
  const real = f.ref.timeline.refetch;
  f.ref.timeline.refetch = async (options) => (options.limit === 200 ? { error: "unavailable" } : real(options));
  const result = await deliverPaseo(f.args);
  assert.equal(result.detail, "Previous delivery could not be checked: Paseo timeline unavailable; no automatic resend");
  assert.equal(f.sent.length, 0);
  assert.equal(f.readReceipt().pending, true);
});

test("settled deliveries and the status check do not count toward 'Nudges can't get through'", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-reconcile-ledger-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new FleetStore({ dir });
  for (const detail of [
    "Previous nudge was delivered (answered; matched by message-hash in the Paseo timeline); reassess before another send",
    "Previous Paseo turn confirmed; reassess the conversation before another send",
    "Sent one status check after an unconfirmable earlier delivery (no replay); the proposed nudge waits for the reply",
  ]) store.recordNudge("thread", { status: "blocked", detail });
  assert.equal(store.ledgerFor("thread").undelivered, null);
});

test("reconcilePaseoReceipt is bounded: a page cap returns ambiguous, an exhausted budget returns inconclusive", async (t) => {
  const f = setup(t, { history: filler(1000) });
  const capped = await reconcilePaseoReceipt(f.ref, staleReceipt(), null, { maxPages: 2 });
  assert.deepEqual({ outcome: capped.outcome, complete: capped.complete, scanned: capped.scanned }, { outcome: "ambiguous", complete: false, scanned: 400 });
  const late = await reconcilePaseoReceipt(f.ref, staleReceipt(), null, { deadline: performance.now() - 1 });
  assert.equal(late.outcome, "inconclusive");
});
