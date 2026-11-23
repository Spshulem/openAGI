// Regression: Paseo session "Make Bob Useful, Actionable, and Habit-Forming"
// (buildbetter #10243), 2026-11-23. The 00:53:35Z Supervisor continuation
// reached the chat and started a turn; at 00:55:20Z Codex stopped it with
// "[System Error] You’ve hit your usage limit ... try again at Nov 23rd,
// 2026 5:58 PM." (a typographic apostrophe). The Supervisor recorded
// error.kind "other" with no reset, kept sending "resume" nudges into the
// errored chat, and asked the owner a generic "Nudges can't get through"
// done/skip card.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyErrorText } from "../src/fleet/errors.js";
import { paseoThread } from "../src/fleet/sources/paseo.js";
import { deliverPaseo } from "../src/fleet/paseo-delivery.js";
import { classifyThread } from "../src/fleet/classify.js";
import { DEFAULTS } from "../src/fleet/contracts.js";
import { BUNDLED_PLAYBOOKS_DIR, loadPlaybooks } from "../src/fleet/playbooks.js";
import { decideThread } from "../src/fleet/policy.js";
import { FleetStore } from "../src/fleet/store.js";
import { FleetSupervisor } from "../src/fleet/supervisor.js";

const MIN = 60_000;
const SERVER = "srv_6csfaHcKvC-A";
const AGENT_ID = "92b67cef-c67d-4d86-ad3d-2d7cdd81a7b4";
const KEY = `paseo:${SERVER}.${AGENT_ID}`;
const NOTICE = "You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 23rd, 2026 5:58 PM.";
const ERROR_AT = "2026-11-23T00:55:20.132Z";
// Codex prints the reset in the machine's zone; the daemon parses it there.
const RESET_AT = new Date(2026, 10, 23, 17, 58, 0, 0).toISOString();
const CONTINUATION = "[OpenAGI supervisor] Resume the existing BoB PR #10243 work from your last checkpoint. First verify the live PR state and exact head; if already merged or closed, report evidence and stop.";

function agent(extra = {}) {
  return {
    id: AGENT_ID, title: "🧭 Make Bob Useful, Actionable, and Habit-Forming", provider: "codex", model: "gpt-6.2-sol",
    status: "error", updatedAt: "2026-11-23T00:55:20.193Z", lastUserMessageAt: "2026-11-23T00:53:35.012Z",
    cwd: "/Volumes/Xtra/codex-worktrees/bob-merge-repairs-20261103/bbapp", workspaceId: "wks_50f93a5ffc8276f2",
    requiresAttention: true, attentionReason: "error", ...extra
  };
}

function timeline(notice = `[System Error] ${NOTICE}`) {
  return [
    { item: { type: "user_message", text: CONTINUATION, messageId: "nudge-0053" }, turnId: "turn-0053", timestamp: "2026-11-23T00:53:35.012Z", seqEnd: 1 },
    { item: { type: "assistant_message", text: "The PR is still open at exact head `06c3f0367178a065c176cfbd85906b654d3a7bf2`. I’m reusing the existing BuildBot3 preview/evidence and will run only the missing UI QA." }, turnId: "turn-0053", timestamp: "2026-11-23T00:53:50.055Z", seqStart: 2 },
    { item: { type: "assistant_message", text: notice }, turnId: "turn-0053", timestamp: ERROR_AT, seqStart: 3 }
  ];
}

test("#10243: Codex's typographic usage-limit notice is a usage limit with its reset", () => {
  const got = classifyErrorText(NOTICE, new Date(ERROR_AT));
  assert.deepEqual(got, { kind: "usage-limit", resetAt: RESET_AT });
  assert.equal(classifyErrorText(`[System Error] ${NOTICE}`, new Date(ERROR_AT))?.kind, "usage-limit");
});

for (const [name, extra, notice] of [
  ["with the [System Error] prefix", {}, undefined],
  ["without the [System Error] prefix", {}, NOTICE],
  ["beside a generic lastError snapshot", { lastError: "Codex turn failed" }, undefined]
]) {
  test(`#10243: the Paseo scan records the quota ${name}`, () => {
    const thread = paseoThread(agent(extra), SERVER, timeline(notice));
    assert.equal(thread.key, KEY);
    assert.equal(thread.error?.kind, "usage-limit");
    assert.equal(thread.error?.resetAt, RESET_AT);
    assert.equal(thread.agentStatus, "error");
  });
}

test("#10243: an idle chat ending on the bare notice is quota-blocked; a report quoting it is not", () => {
  const bare = paseoThread(agent({ status: "idle", requiresAttention: false }), SERVER, timeline(NOTICE));
  assert.equal(bare.error?.kind, "usage-limit");
  assert.equal(bare.error?.resetAt, RESET_AT);
  const quoted = `Earlier the run said "${NOTICE}" but I switched accounts and the QA pass is complete with screenshots attached to the PR. ${"Details. ".repeat(80)}`;
  const thread = paseoThread(agent({ status: "idle", requiresAttention: false }), SERVER, timeline(quoted));
  assert.equal(thread.error, null);
});

const playbooks = loadPlaybooks({ bundledDir: BUNDLED_PLAYBOOKS_DIR });
const config = { mode: "auto", selfSessionIds: [], limits: { ...DEFAULTS } };
const pr = {
  ref: "buildbetter-app/buildbetter#10243", repo: "buildbetter-app/buildbetter", number: 10243, state: "OPEN", isDraft: false,
  headOid: "06c3f0367178a065c176cfbd85906b654d3a7bf2", mergeState: "BLOCKED", reviewDecision: "REVIEW_REQUIRED",
  ci: { state: "FAILURE", failing: ["main-health"], pending: [] }, unresolvedThreads: 0,
  qa: { required: true, freshOnHead: false, sha: null }, updatedAt: "2026-11-23T04:28:49.000Z"
};
// The live ledger: three "resume" sends refused between the quota and its reset.
const ledger = {
  nudges: ["01:11:02.225", "01:17:01.941", "01:27:34.572"].map((t) => ({
    at: `2026-11-23T${t}Z`, playbook: "resume", route: "paseo-send", status: "blocked", messageHash: "6eacd40c599e0d18"
  })),
  lastProgressMark: { head: pr.headOid, unresolved: 0 }, attemptsWithoutProgress: 0, lastNudgeAt: null,
  undelivered: { count: 3, since: "2026-11-23T01:11:02.225Z", lastAt: "2026-11-23T01:27:34.572Z", reason: "Paseo chat is active, closed, or unavailable", ackedAt: null }
};

function decide(now) {
  const thread = paseoThread(agent(), SERVER, timeline());
  const classified = classifyThread(thread, { pr, now, config });
  return { classified, decision: decideThread(classified, thread, { ledger, playbooks, config, now, pr, mode: "auto" }) };
}

test("#10243: during the quota the Supervisor holds the chat; no blind resend, no done/skip delivery card", () => {
  const { classified, decision } = decide(Date.parse("2026-11-23T05:40:00.000Z"));
  assert.equal(classified.state, "infra-blocked");
  assert.equal(classified.infraKind, "usage-limit");
  assert.notEqual(decision.action, "nudge");
  assert.notEqual(decision.question?.kind, "deliver");
  assert.ok(!/can't deliver/.test(decision.reason ?? ""), decision.reason);
});

test("#10243: after the reset the Supervisor resumes; refusals during the quota are no delivery failure", () => {
  const { decision } = decide(Date.parse(RESET_AT) + 3 * MIN);
  assert.equal(decision.action, "nudge");
  assert.equal(decision.playbook, "resume");
  assert.equal(decision.route, "paseo-send");
});

function deliverySetup(t, { agentExtra = {}, entries = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-quota-10243-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const current = agent(agentExtra);
  const sent = [];
  const ref = {
    refresh: async () => {},
    current: () => current,
    send: async (text, options) => { sent.push({ text, options }); },
    timeline: {
      refetch: async () => ({
        agent: current,
        entries: [
          ...entries,
          ...sent.map((s, i) => [
            { item: { type: "user_message", messageId: s.options.messageId }, turnId: `turn-new-${i}`, timestamp: "2026-11-24T02:01:00.000Z" },
            { item: { type: "assistant_message", text: "Resuming the UI QA." }, turnId: `turn-new-${i}` }
          ]).flat()
        ]
      })
    }
  };
  const factory = () => ({ connect: async () => {}, close: async () => {}, hosts: { list: async () => ({ self: { serverId: SERVER }, hosts: [] }) }, agents: { ref: () => ref } });
  const thread = paseoThread(current, SERVER, timeline());
  return { dir, sent, thread, args: { config: { paseo: { enabled: true } }, thread, text: "continue", store: { dir }, actionId: "a", factory } };
}

test("#10243: a send before the reset is held as a quota wait, not a delivery failure", async (t) => {
  const f = deliverySetup(t);
  const result = await deliverPaseo({ ...f.args, thread: { ...f.thread, error: { ...f.thread.error, resetAt: new Date(Date.now() + 60 * MIN).toISOString() } }, base: { playbook: "resume", messageHash: "h" } });
  assert.equal(result.status, "blocked");
  assert.match(result.detail, /^Provider usage-limit until .*Supervisor resumes after the reset/);
  assert.equal(f.sent.length, 0);
  const store = new FleetStore({ dir: path.join(f.dir, "fleet") });
  store.recordNudge(KEY, { playbook: "resume", route: "paseo-send", status: "blocked", detail: result.detail });
  assert.equal(store.ledgerFor(KEY).undelivered, null);
});

test("#10243: the Supervisor's resume after the reset reaches the errored chat", async (t) => {
  const f = deliverySetup(t);
  const result = await deliverPaseo({ ...f.args, thread: { ...f.thread, error: { ...f.thread.error, resetAt: new Date(Date.now() - 3 * MIN).toISOString() } }, base: { playbook: "resume", messageHash: "h" } });
  assert.equal(result.status, "sent", result.detail);
  assert.equal(f.sent.length, 1);
});

test("#10243: an unrelated nudge into the errored chat names the error, not 'active, closed, or unavailable'", async (t) => {
  const f = deliverySetup(t);
  const result = await deliverPaseo({ ...f.args, thread: { ...f.thread, error: { kind: "other", resetAt: null } }, base: { playbook: "merge-ready", messageHash: "h" } });
  assert.equal(result.status, "blocked");
  assert.match(result.detail, /^Paseo chat stopped on an error/);
  assert.equal(f.sent.length, 0);
});

test("#10243: a nudge delivered whose turn then hit the quota is settled as delivered, not 'no confirmed turn'", async (t) => {
  const f = deliverySetup(t, { agentExtra: { status: "idle" }, entries: timeline() });
  const file = path.join(f.dir, "paseo-deliveries");
  fs.mkdirSync(file, { recursive: true });
  const { createHash } = await import("node:crypto");
  const receiptPath = path.join(file, `${createHash("sha256").update(KEY).digest("hex")}.json`);
  // The 00:53:35 continuation's receipt, left pending (no turn learned yet).
  fs.writeFileSync(receiptPath, JSON.stringify({ messageId: "nudge-0053", clientMessageId: "nudge-0053", messageHash: "prior", activityAt: "2026-11-23T00:52:00.000Z", pending: true }));
  const thread = { ...f.thread, error: null, agentStatus: "idle" };
  const first = await deliverPaseo({ ...f.args, thread, base: { playbook: "idle-report", messageHash: "next" } });
  assert.equal(first.status, "blocked");
  assert.match(first.detail, /^Previous nudge was delivered; its turn then failed \(You.ve hit your usage limit/);
  assert.doesNotMatch(first.detail, /no confirmed turn/);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.pending, false);
  assert.match(receipt.executionError, /usage limit/);
  assert.equal(f.sent.length, 0);
  const store = new FleetStore({ dir: path.join(f.dir, "fleet") });
  store.recordNudge(KEY, { playbook: "idle-report", route: "paseo-send", status: "blocked", detail: first.detail });
  assert.equal(store.ledgerFor(KEY).undelivered, null);
});

test("#10243: the Supervisor scan shows the quota on the thread and raises no generic session-error card", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-quota-10243-sup-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const live = agent();
  const factory = () => ({
    connect: async () => {}, close: async () => {},
    hosts: { list: async () => ({ self: { serverId: SERVER }, hosts: [] }) },
    agents: {
      list: async () => ({ entries: [{ agent: live }], pageInfo: { hasMore: false, nextCursor: null } }),
      ref: () => ({ timeline: { refetch: async () => ({ agent: live, entries: timeline() }) } })
    }
  });
  // Two hours before the reset: the policy waits it out on its own.
  const sup = new FleetSupervisor({
    dataDir,
    config: { enabled: true, mode: "observe", paseo: { enabled: true, only: true, url: "ws://127.0.0.1:6767/ws", projectsDir: false } },
    deps: { now: () => Date.parse(RESET_AT) - 120 * MIN, paseoFactory: factory }
  });
  await sup.tick();
  const state = sup.getState();
  const row = state.snapshot.threads.find((r) => r.key === KEY);
  assert.ok(row, "thread scanned");
  assert.equal(row.error?.kind, "usage-limit");
  assert.equal(row.error?.resetAt, RESET_AT);
  assert.equal(row.decision?.action, "wait");
  const cards = state.cards.filter((c) => c.threadKey === KEY || (c.threadKeys ?? []).includes(KEY));
  assert.deepEqual(cards.map((c) => c.kind), [], "no session-error or deliver card for a quota the Supervisor waits out");
});
