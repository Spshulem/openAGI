// Owner authority primitives: the unforgeable principal, the spoken confirm
// matcher, and the intent families a tainted turn checks.
import test from "node:test";
import assert from "node:assert/strict";
import {
  authorityRecord, intentCovers, intentFamilies, isOwnerPrincipal, matchConfirmation, ownerAuthorityEnabled,
  ownerIntentText, ownerPrincipal
} from "../src/owner-authority.js";

test("only a minted principal passes; copies, JSON and replays never do", () => {
  const real = ownerPrincipal("g2", "node-1");
  assert.equal(isOwnerPrincipal(real), true);
  assert.equal(Object.isFrozen(real), true);
  assert.deepEqual(authorityRecord(real), { kind: "owner", via: "g2", nodeId: "node-1" });
  // Same shape, not the same object.
  assert.equal(isOwnerPrincipal({ kind: "owner", via: "g2", nodeId: "node-1" }), false);
  assert.equal(isOwnerPrincipal({ ...real }), false);
  assert.equal(isOwnerPrincipal(JSON.parse(JSON.stringify(real))), false);
  assert.equal(isOwnerPrincipal(structuredClone(real)), false);
  assert.equal(isOwnerPrincipal(authorityRecord(real)), false);
  for (const value of [null, undefined, "owner", true, 1, []]) assert.equal(isOwnerPrincipal(value), false);
  assert.equal(authorityRecord({ kind: "owner", via: "phone" }), null);
  assert.throws(() => ownerPrincipal("telegram"), /unknown owner transport/);
});

test("the kill switch turns every principal off", () => {
  const real = ownerPrincipal("owner");
  assert.equal(isOwnerPrincipal(real, { OPENAGI_OWNER_AUTHORITY: "off" }), false);
  assert.equal(isOwnerPrincipal(real, { OPENAGI_OWNER_AUTHORITY: "on" }), true);
  assert.equal(ownerAuthorityEnabled({}), true);
  assert.equal(ownerAuthorityEnabled({ OPENAGI_OWNER_AUTHORITY: "OFF" }), false);
});

test("spoken confirms match whole assent or refusal, with an optional code", () => {
  const yes = [
    ["yes", null], ["Yes.", null], ["yeah", null], ["ok", null], ["approve", null], ["approved", null],
    ["do it", null], ["go ahead", null], ["send it", null], ["click approve", null], ["Yes please", null],
    ["Yes. Please approve that", null], ["yes, do it now", null], ["Yes 42", "42"], ["approve 17 please", "17"],
    ["42 yes", "42"], ["confirm code 305", "305"], ["Go ahead!", null], ["click allow", null]
  ];
  for (const [text, code] of yes) assert.deepEqual(matchConfirmation(text), { decision: "approve", code }, text);
  const no = [["no", null], ["No 42", "42"], ["cancel", null], ["don't", null], ["do not allow", null], ["deny 88", "88"], ["nope.", null]];
  for (const [text, code] of no) assert.deepEqual(matchConfirmation(text), { decision: "deny", code }, text);
});

test("bystander sentences, mixed answers and long text are not confirms", () => {
  for (const text of [
    "yes I think we should wait", "approve the PR on GitHub", "can you approve that?", "no idea what that is",
    "what's the latest?", "yes no", "yes 42 17", "approve 4", "approve 4242", "ok so the build is red", "",
    "please", "it", `yes ${"please ".repeat(30)}`
  ]) assert.equal(matchConfirmation(text), null, text);
});

test("intent families cover only their own tools", () => {
  assert.deepEqual(intentFamilies("click approve for me"), ["approve"]);
  assert.equal(intentCovers("Click Approve on the Codex prompt", "fleet_click"), true);
  assert.equal(intentCovers("tell the openAGI thread to rebase", "fleet_send_message"), true);
  assert.equal(intentCovers("restart conductor", "fleet_app"), true);
  assert.equal(intentCovers("can you restart Conductor?", "fleet_app"), true);
  assert.equal(intentCovers("I need you to restart Codex", "fleet_app"), true);
  assert.equal(intentCovers("use my computer to check the screen", "start_computer_use_session"), true);
  assert.equal(intentCovers("open Safari and check my Gmail", "start_computer_use_session"), true);
  assert.equal(intentCovers("start a codex agent to fix it", "start_coding_agent"), true);
  // What a tainted turn must not get without the code.
  assert.equal(intentCovers("what's the latest?", "fleet_click"), false);
  assert.equal(intentCovers("what's the latest?", "fleet_send_message"), false);
  assert.equal(intentCovers("summarize thread 4", "fleet_app"), false);
  // Nouns and questions name no action.
  assert.equal(intentCovers("What is the Claude agent doing?", "start_coding_agent"), false);
  assert.equal(intentCovers("what did codex say?", "fleet_send_message"), false);
  assert.equal(intentCovers("what did codex say?", "reply_to_coding_agent"), false);
  assert.equal(intentCovers("tell me what amman is doing", "fleet_send_message"), false);
  assert.equal(intentCovers("did you restart conductor?", "fleet_app"), false);
  assert.equal(intentCovers("don't restart conductor", "fleet_app"), false);
  assert.equal(intentCovers("any new texts?", "fleet_click"), false);
  assert.equal(intentCovers("summarize this", "start_computer_use_session"), false);
  assert.equal(intentCovers("open the PR", "start_computer_use_session"), false, "computer needs a computer noun");
  // Coding needs coding phrasing: generic verbs alone never launch an agent.
  for (const text of ["have claude fix the login bug", "spin up a coding agent", "fix the failing tests", "repair PR 140", "watch codex",
    "Implement dark mode in the openAGI repo", "Refactor the fleet supervisor", "Debug why the G2 page is blank", "fix issue #42",
    "start a coding session", "check CI on PR 142 and fix it", "use codex to fix the build", "run Claude Code on the openAGI repo",
    "send codex in to fix the build", "get codex to add a test", "have the agent fix the crash"]) {
    assert.equal(intentCovers(text, "start_coding_agent") || intentCovers(text, "watch_coding_agent"), true, text);
  }
  for (const text of ["get the latest news", "watch the game", "monitor the stock price", "put it on my calendar", "have a look at my email", "fix it", "build me a website",
    // A bare agent or Claude needs a coding verb after it; a possessive is not a dispatch.
    "have the agent check the news", "get my agent to summarize the news", "have claude summarize my email", "get codex's status",
    "get codex status", "put the agent's notes in a doc", "start claude", "fix my calendar"]) {
    assert.equal(intentCovers(text, "start_coding_agent"), false, text);
    assert.equal(intentCovers(text, "watch_coding_agent"), false, text);
  }
  assert.equal(intentCovers("watch codex", "start_coding_agent"), false, "watching never starts an agent");
  // Messaging needs a target: a generic verb alone never messages an agent.
  for (const text of ["tell amman to continue", "reply to the recorder chat: yes", "send yes to amman", "nudge the openAGI thread",
    "message amman", "ask claude whether the tests pass", "answer the codex prompt with yes", "write to the recorder chat: ship it",
    "can you ping the conductor workspace", "respond to amman with go ahead"]) {
    assert.equal(intentCovers(text, "fleet_send_message"), true, text);
    assert.equal(intentCovers(text, "reply_to_coding_agent"), true, text);
  }
  for (const text of ["write a summary of these search results", "ask a question about this page", "answer this email",
    "write it up", "respond briefly", "send it", "write a summary of the agent's work", "ping me when it's done", "tell me the news"]) {
    assert.equal(intentCovers(text, "fleet_send_message"), false, text);
    assert.equal(intentCovers(text, "reply_to_coding_agent"), false, text);
  }
  // A gated tool outside every family always needs the code.
  assert.equal(intentCovers("send it, approve it, restart it", "schedule_message"), false);
});

test("intent is the owner's own words only, never the previous assistant message", () => {
  const messages = [
    { role: "user", content: "what needs me?" },
    { role: "assistant", content: "Codex asks to run tests. Want me to click Allow?" }
  ];
  assert.equal(ownerIntentText("yes", messages), "yes");
  assert.equal(ownerIntentText("restart conductor", messages), "restart conductor");
});

test("an acknowledgement is not assent", () => {
  for (const text of ["ok thanks", "ok thank you", "thanks", "yes thank you"]) assert.equal(matchConfirmation(text), null, text);
});
