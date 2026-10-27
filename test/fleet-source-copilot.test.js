import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveFleetConfig, openChatFor, THREAD_KINDS } from "../src/fleet/contracts.js";
import { chooseRoute } from "../src/fleet/policy.js";
import { mergeThreads } from "../src/fleet/classify.js";
import { listCopilotThreads, parseWorkspaceYaml } from "../src/fleet/sources/copilot.js";

const NOW = Date.parse("2026-10-25T20:00:00.000Z");
const MIN = 60_000;
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

function makeHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-copilot-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function writeSession(home, id, events, { name = "Fix login", mtimeMsAgo = MIN, extraYaml = "" } = {}) {
  const dir = path.join(home, ".copilot", "session-state", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "events.jsonl"), events.map((row) => JSON.stringify(row)).join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "workspace.yaml"), `id: ${id}\nclient_name: vscode-agent-host\nname: ${name}\n${extraYaml}`);
  const at = new Date(NOW - mtimeMsAgo);
  fs.utimesSync(path.join(dir, "events.jsonl"), at, at);
}

const ev = (type, data, msAgo) => ({ type, data, timestamp: iso(msAgo) });
const start = (cwd, msAgo = 30 * MIN, branch = "feature/x") =>
  ev("session.start", { sessionId: "s", selectedModel: "claude-sonnet-5.5", context: { cwd, gitRoot: cwd, branch } }, msAgo);
const prompt = (text, msAgo) => ev("user.message", { content: text }, msAgo);
const turnStart = (msAgo) => ev("assistant.turn_start", { turnId: "0" }, msAgo);
const turnEnd = (msAgo) => ev("assistant.turn_end", { turnId: "0" }, msAgo);
const reply = (text, msAgo) => ev("assistant.message", { content: text, model: "claude-sonnet-5.5", toolRequests: [] }, msAgo);

const config = (home) => resolveFleetConfig({}, { home });

test("a finished turn is idle with the last reply and PR link", async (t) => {
  const home = makeHome(t);
  writeSession(home, "idle-1", [
    start("/work/app"), prompt("fix it", 20 * MIN), turnStart(19 * MIN),
    reply("Done, see https://github.com/acme/app/pull/12", 18 * MIN), turnEnd(17 * MIN)
  ]);
  const [thread] = await listCopilotThreads(config(home), { now: NOW });
  assert.equal(thread.key, "copilot:idle-1");
  assert.equal(thread.kind, "copilot");
  assert.equal(thread.agentStatus, "idle");
  assert.equal(thread.title, "Fix login");
  assert.equal(thread.branch, "feature/x");
  assert.equal(thread.cwd, "/work/app");
  assert.deepEqual(thread.prRefs, ["acme/app#12"]);
  assert.equal(thread.repo, "acme/app");
  assert.match(thread.lastAgentText, /Done/);
  assert.equal(thread.lastUserText, "fix it");
  assert.equal(thread.excluded, null);
  assert.equal(thread.meta.model, "claude-sonnet-5.5");
});

test("an open turn is running while fresh and stalled when old", async (t) => {
  const home = makeHome(t);
  writeSession(home, "run-1", [start("/work/app"), prompt("go", 2 * MIN), turnStart(2 * MIN)], { mtimeMsAgo: 30_000 });
  writeSession(home, "stall-1", [start("/work/app"), prompt("go", 40 * MIN), turnStart(40 * MIN)], { mtimeMsAgo: 40 * MIN });
  const threads = await listCopilotThreads(config(home), { now: NOW });
  const byId = Object.fromEntries(threads.map((thread) => [thread.id, thread]));
  assert.equal(byId["run-1"].agentStatus, "running");
  assert.equal(byId["stall-1"].agentStatus, "stalled");
});

test("an unanswered permission request waits on the owner; a resolved one does not", async (t) => {
  const home = makeHome(t);
  const ask = ev("permission.requested", { requestId: "r1", promptRequest: { kind: "shell", intention: "Run rm -rf build" } }, MIN);
  writeSession(home, "wait-1", [start("/work/app"), prompt("clean", 3 * MIN), turnStart(3 * MIN), ask], { mtimeMsAgo: MIN });
  writeSession(home, "ok-1", [start("/work/app"), prompt("clean", 3 * MIN), turnStart(3 * MIN), ask,
    ev("permission.completed", { requestId: "r1", result: { kind: "approved" } }, 30_000)], { mtimeMsAgo: 30_000 });
  const threads = await listCopilotThreads(config(home), { now: NOW });
  const byId = Object.fromEntries(threads.map((thread) => [thread.id, thread]));
  assert.equal(byId["wait-1"].agentStatus, "waiting");
  assert.equal(byId["wait-1"].meta.blockedOnOwner, true);
  assert.match(byId["wait-1"].meta.waitingFor, /rm -rf build/);
  assert.equal(byId["ok-1"].agentStatus, "running");
});

test("session errors and mid-turn shutdowns are reported", async (t) => {
  const home = makeHome(t);
  writeSession(home, "err-1", [start("/work/app"), prompt("go", 5 * MIN), turnStart(5 * MIN),
    ev("session.error", { errorType: "query", message: "No response was returned. Send your message again to retry." }, 4 * MIN)]);
  writeSession(home, "abort-1", [start("/work/app"), prompt("go", 5 * MIN), turnStart(5 * MIN), ev("session.shutdown", {}, 4 * MIN)]);
  writeSession(home, "done-1", [start("/work/app"), prompt("go", 5 * MIN), turnStart(5 * MIN), turnEnd(4 * MIN), ev("session.shutdown", {}, 3 * MIN)]);
  const threads = await listCopilotThreads(config(home), { now: NOW });
  const byId = Object.fromEntries(threads.map((thread) => [thread.id, thread]));
  assert.equal(byId["err-1"].agentStatus, "error");
  assert.ok(byId["err-1"].error.text.includes("No response"));
  assert.equal(byId["abort-1"].agentStatus, "aborted");
  assert.equal(byId["done-1"].agentStatus, "idle");
});

test("folderless chats, temp dirs and own prompts are excluded; old sessions are skipped", async (t) => {
  const home = makeHome(t);
  const events = (cwd) => [start(cwd), prompt("hi", 10 * MIN), turnStart(10 * MIN), turnEnd(9 * MIN)];
  writeSession(home, "chat-1", events(path.join(home, ".copilot", "chats", "abc")));
  writeSession(home, "tmp-1", events("/private/tmp/x"));
  writeSession(home, "old-1", events("/work/app"), { mtimeMsAgo: 400 * 60 * MIN });
  writeSession(home, "ok-1", events("/work/app"));
  const threads = await listCopilotThreads(config(home), { now: NOW });
  const byId = Object.fromEntries(threads.map((thread) => [thread.id, thread]));
  assert.equal(byId["chat-1"].excluded, "no-repo");
  assert.equal(byId["tmp-1"].excluded, "tmp");
  assert.equal(byId["ok-1"].excluded, null);
  assert.equal(byId["old-1"], undefined);
});

test("secrets in replies are redacted", async (t) => {
  const home = makeHome(t);
  writeSession(home, "sec-1", [start("/work/app"), prompt("go", 5 * MIN), turnStart(5 * MIN),
    reply("token ghp_abcdefghijklmnopqrstuvwxyz0123456789", 4 * MIN), turnEnd(3 * MIN)]);
  const [thread] = await listCopilotThreads(config(home), { now: NOW });
  assert.ok(!thread.lastAgentText.includes("ghp_abcdef"));
});

test("a missing install is empty and the source can be turned off", async (t) => {
  const home = makeHome(t);
  assert.deepEqual(await listCopilotThreads(config(home), { now: NOW }), []);
  writeSession(home, "a-1", [start("/work/app"), prompt("go", MIN), turnStart(MIN), turnEnd(MIN)]);
  const off = resolveFleetConfig({ OPENAGI_FLEET_COPILOT: "0" }, { home });
  assert.deepEqual(await listCopilotThreads(off, { now: NOW }), []);
});

test("only reads the named sessions", async (t) => {
  const home = makeHome(t);
  for (const id of ["a-1", "b-1"]) writeSession(home, id, [start("/work/app"), prompt("go", MIN), turnStart(MIN), turnEnd(MIN)]);
  const threads = await listCopilotThreads(config(home), { now: NOW, only: ["b-1"] });
  assert.deepEqual(threads.map((thread) => thread.id), ["b-1"]);
});

test("workspace.yaml parsing", () => {
  assert.deepEqual(parseWorkspaceYaml("id: x\nname: \"Hello: world\"\nbranch: main\n"), { id: "x", name: "Hello: world", branch: "main" });
});

test("copilot threads merge in, have no delivery route, and open by label", async (t) => {
  assert.ok(THREAD_KINDS.includes("copilot"));
  const home = makeHome(t);
  writeSession(home, "m-1", [start("/work/app"), prompt("go", MIN), turnStart(MIN), turnEnd(MIN)]);
  const copilot = await listCopilotThreads(config(home), { now: NOW });
  const merged = mergeThreads({ copilot });
  assert.equal(merged.length, 1);
  for (const mode of ["auto", "cli", "computer-use"]) assert.equal(chooseRoute(merged[0], mode), null);
  const open = openChatFor(merged[0]);
  assert.equal(open.app, "copilot");
  assert.equal(open.url, null);
  assert.match(open.label, /GitHub Copilot/);
});
