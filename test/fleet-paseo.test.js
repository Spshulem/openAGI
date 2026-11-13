import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createPaseoSource, paseoThread, hostApi, withPaseo } from "../src/fleet/sources/paseo.js";
import { deliverPaseo } from "../src/fleet/paseo-delivery.js";
import { classifyThread, mergeThreads, threadHealth } from "../src/fleet/classify.js";
import { decideThread } from "../src/fleet/policy.js";
import { openChatFor, resolveFleetConfig } from "../src/fleet/contracts.js";

const config = { paseo: { enabled: true, historyPerScan: 1 } };
const agent = (id, extra = {}) => ({ id, status: "idle", updatedAt: "2026-01-01T00:00:00Z", cwd: "/workspace/project", workspaceId: "workspace", provider: "codex", ...extra });
function mock(agents, { remote = [], failHistory = false } = {}) {
  const reads = [], lists = [];
  let closes = 0;
  const api = rows => ({ agents: {
    list: async options => { lists.push(options); const start = Number(options.page.cursor ?? 0); return { entries: rows.slice(start, start + 2).map(agent => ({ agent })), pageInfo: { hasMore: start + 2 < rows.length, nextCursor: String(start + 2) } }; },
    ref: id => ({ timeline: { refetch: async () => { reads.push(id); if (failHistory) throw Error("unavailable"); return { agent: rows.find(a => a.id === id), entries: [{ item: { type: "assistant_message", text: "Completed." }, timestamp: "2026-01-01T00:00:00Z" }] }; } } })
  } });
  const client = { ...api(agents), connect: async () => {}, close: async () => { closes++; }, hosts: { list: async () => ({ self: { serverId: "local" }, hosts: [{ serverId: "remote", enabled: true, status: "online" }] }), client: async () => api(remote) } };
  return { factory: () => client, client, reads, lists, closes: () => closes };
}
test("Paseo is opt-in and has host-scoped identity without local filesystem paths", () => {
  assert.equal(resolveFleetConfig({}).paseo.enabled, false);
  const a = paseoThread(agent("same"), "a"), b = paseoThread(agent("same"), "b");
  assert.notEqual(a.key, b.key);
  assert.equal(a.cwd, null);
  assert.equal(openChatFor(a).app, "paseo");
  assert.equal(openChatFor(a).serverId, "a");
});
test("pagination includes background chats; bounded history makes fair progress and caches", async () => {
  const m = mock([agent("a"), agent("b"), agent("c")]);
  const source = createPaseoSource(m);
  let rows = await source(config);
  assert.equal(rows.length, 3);
  assert.equal(rows.filter(t => t.excluded === "history-unavailable").length, 2);
  await source(config); rows = await source(config);
  assert.deepEqual(m.reads, ["a", "b", "c"]);
  assert.ok(rows.every(t => !t.excluded));
  await source(config);
  assert.equal(m.reads.length, 3);
  assert.ok(m.lists.every(o => o.filter.includeBackground && !o.filter.includeArchived));
});
test("registered hosts preserve distinct same-ID chats; unavailable hosts fail closed", async () => {
  const m = mock([agent("same")], { remote: [agent("same")] });
  const rows = await createPaseoSource(m)({ paseo: { enabled: true, serverIds: ["remote"] } });
  assert.equal(new Set(rows.map(t => t.key)).size, 2);
  await assert.rejects(hostApi(m.client, "unregistered"), /unavailable/);
});
test("failed histories remain excluded, permissions remain owner-blocked, closed stays closed", async () => {
  const m = mock([agent("a")], { failHistory: true });
  assert.equal((await createPaseoSource(m)(config))[0].excluded, "history-unavailable");
  assert.equal(paseoThread(agent("a", { pendingPermissions: [{}] }), "local").meta.blockedOnOwner, true);
  assert.equal(paseoThread(agent("a", { status: "closed" }), "local").excluded, "closed");
});
test("migration aliases suppress original provider delivery", () => {
  const native = paseoThread(agent("new", { labels: { "migration.source": "codex", "migration.sourceId": "old" } }), "local");
  const rows = mergeThreads({ codex: [{ key: "codex:old" }], paseo: [native] });
  assert.equal(rows.find(t => t.key === "codex:old").excluded, "paseo-migrated");
});
test("unsafe endpoint is rejected before connecting; concurrent scans do not overlap", async () => {
  let calls = 0;
  await assert.rejects(withPaseo({ paseo: { url: "ws://remote.example/ws" } }, () => {}, () => { calls++; }), /require wss/);
  assert.equal(calls, 0);
  let finish;
  const m = mock([]);
  m.client.connect = () => new Promise(resolve => { finish = resolve; });
  const source = createPaseoSource(m);
  const one = source(config), two = source(config);
  assert.equal(one, two);
  finish(); await one;
  assert.equal(m.closes(), 1);
});
test("disabled delivery cannot mutate an existing chat", async () => {
  const result = await deliverPaseo({ actionId: "action", factory: () => { throw Error("must not connect"); } });
  assert.equal(result.status, "blocked");
  assert.match(result.detail, /not enabled/);
});
test("incomplete pagination fails closed", async () => {
  const m = mock([]);
  m.client.agents.list = async () => ({ entries: [{ agent: agent("a") }], pageInfo: { hasMore: true, nextCursor: "repeat" } });
  await assert.rejects(createPaseoSource(m)(config), /incomplete/);
  assert.equal(m.closes(), 1);
});
test("timeout aborts late history work and closes only the owned client", async () => {
  const m = mock([agent("a")]);
  let resolveHistory;
  m.client.agents.ref = () => ({ timeline: { refetch: () => new Promise(resolve => { resolveHistory = resolve; }) } });
  const source = createPaseoSource(m);
  await assert.rejects(source({ paseo: { enabled: true, timeoutMs: 10 } }), /timed out/);
  assert.equal(m.closes(), 1);
  resolveHistory({ agent: agent("a"), entries: [] });
  await new Promise(resolve => setImmediate(resolve));
});

test("Paseo histories retain explicit PR links for live CI and review lookup", () => {
  const row = paseoThread(agent("a"), "local", [
    { item: { type: "user_message", text: "Finish https://github.com/example/project/pull/12" } },
    { item: { type: "assistant_message", text: "Follow-up https://github.com/example/project/pull/13. Previous: https://github.com/example/project/pull/12" } }
  ]);
  assert.deepEqual(row.prRefs, ["example/project#13", "example/project#12"]);
  assert.equal(row.repo, "example/project");
  assert.equal(row.cwd, null);
});

test("one slow history preserves inventory and other histories", async () => {
 const m=mock([agent("slow"),agent("ready")]);const original=m.client.agents.ref;
 m.client.agents.ref=id=>id==='slow'?{timeline:{refetch:()=>new Promise(()=>{})}}:original(id);
 const rows=await createPaseoSource(m)({paseo:{enabled:true,historyTimeoutMs:5}});
 assert.equal(rows.length,2);assert.equal(rows[0].excluded,'history-unavailable');assert.equal(rows[1].excluded,null);
});


test("embedded daemon can load disabled Paseo without its desktop SDK", () => {
  const loader = `export async function resolve(specifier, context, next) {
    if (specifier === "@getpaseo/client") throw new Error("Paseo SDK omitted from embedded bundle");
    return next(specifier, context);
  }`;
  const source = new URL("../src/fleet/sources/paseo.js", import.meta.url).href;
  const delivery = new URL("../src/fleet/paseo-delivery.js", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    const { createPaseoSource } = await import(${JSON.stringify(source)});
    await import(${JSON.stringify(delivery)});
    const scan = createPaseoSource();
    assert.deepEqual(await scan({ paseo: { enabled: false } }), []);
    await assert.rejects(scan({ paseo: { enabled: true } }), /SDK omitted/);
  `;
  const result = spawnSync(process.execPath, [
    "--experimental-loader", `data:text/javascript,${encodeURIComponent(loader)}`,
    "--input-type=module", "--eval", script
  ], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test("supervisor nudges never become owner instructions in judge context", () => {
  const entries = [
    { item: { type: "user_message", text: "Review only" } },
    { item: { type: "user_message", text: "[OpenAGI supervisor] Continue" } },
    { item: { type: "assistant_message", text: "Reviewed" } }
  ];
  const row = paseoThread(agent("a"), "host", entries);
  assert.equal(row.lastUserText, "Review only");
  assert.deepEqual(row.meta.conversation.map(m => m.text), ["Review only", "Reviewed"]);
});

const capacityError = "Selected model is at capacity. Please try a different model.";
const failureAt = "2026-01-01T00:10:00Z";
const laterAt = "2026-01-01T00:20:00Z";
const errorEntry = (message = capacityError) => ({ timestamp: failureAt, item: { type: "error", message } });

test("Paseo system errors reach the existing model-limit question through fresh and cached discovery", async () => {
  const a = agent("failed", { status: "error", model: "test-model", updatedAt: failureAt });
  const entries = [
    { timestamp: "2026-01-01T00:09:00Z", item: { type: "assistant_message", text: "I will finish the verification." } },
    errorEntry(),
    { timestamp: failureAt, item: { type: "tool_call", status: "failed", detail: { output: "private tool output" } } }
  ];
  const m = mock([a]);
  m.client.agents.ref = id => ({ timeline: { refetch: async () => {
    m.reads.push(id);
    return { agent: a, entries };
  } } });
  const source = createPaseoSource(m);
  for (let scan = 0; scan < 2; scan++) {
    const [row] = await source(config);
    assert.equal(row.error?.kind, "model-limit");
    assert.equal(row.error.text, capacityError);
    assert.equal(row.meta.model, "test-model");
    const classified = classifyThread(row);
    assert.equal(classified.state, "infra-blocked");
    assert.equal(threadHealth(classified.state, row.error), "red");
    const decision = decideThread(classified, row, { mode: "auto", now: Date.parse(laterAt) });
    assert.equal(decision.action, "ask-user");
    assert.equal(decision.message, null);
    assert.match(decision.question.title, /test-model capped\. Switch model\?/);
    assert.deepEqual(decision.question.options, ["switched", "wait"]);
    assert.deepEqual(row.meta.conversation.map(m => m.text), ["I will finish the verification."]);
    assert.equal(JSON.stringify(row).includes("private tool output"), false);
  }
  assert.equal(m.reads.length, 1, "cached scans retain the error without another history read");
});

test("Paseo snapshot errors survive a bounded history without an error event", () => {
  const row = paseoThread(agent("failed", { status: "error", lastError: capacityError, updatedAt: failureAt }), "host");
  assert.equal(row.error?.kind, "model-limit");
  const unknown = paseoThread(agent("failed", { status: "error", lastError: "Provider failed unexpectedly" }), "host");
  assert.equal(unknown.error?.kind, "other");
  assert.equal(threadHealth(classifyThread(unknown).state, unknown.error), "red");
  const unread = paseoThread(agent("failed", { status: "error", lastError: capacityError }), "host", [], false);
  assert.equal(classifyThread(unread).state, "excluded", "an error cannot bypass unknown-history exclusion");
});

test("Paseo idle failures remain detectable and a newer failure replaces the older one", () => {
  const row = paseoThread(agent("a"), "host", [errorEntry()]);
  assert.equal(row.error?.kind, "model-limit");
  const newer = paseoThread(agent("a"), "host", [errorEntry(), errorEntry("Connection failed")]);
  assert.equal(newer.error?.kind, "network");
});

test("Paseo error notices clear after a newer message or a new active turn", () => {
  for (const type of ["user_message", "assistant_message"]) {
    const row = paseoThread(agent("a"), "host", [errorEntry(), { timestamp: laterAt, item: { type, text: "Continue" } }]);
    assert.equal(row.error, null, type);
  }
  const entries = [errorEntry()];
  const retry = paseoThread(agent("a", { lastUserMessageAt: laterAt }), "host", entries);
  assert.equal(retry.error, null, "a retry outside the history page supersedes the old failure");
  for (const extra of [
    { status: "running" }, { status: "initializing" }, { status: "closed" },
    { archivedAt: laterAt }, { status: "error", activeTurn: { startedAt: laterAt } }
  ]) {
    const row = paseoThread(agent("a", { lastError: capacityError, ...extra }), "host", entries);
    assert.equal(row.error, null, JSON.stringify(extra));
  }
  assert.equal(paseoThread(agent("a", { lastError: capacityError }), "host").error, null,
    "idle snapshot lastError alone is not evidence of a current failure");
});

test("Paseo detects only structured provider errors, not quoted errors or tool failures", () => {
  const entries = [
    { item: { type: "user_message", text: capacityError } },
    { item: { type: "assistant_message", text: capacityError } },
    { item: { type: "tool_call", status: "failed", error: capacityError } },
    { item: { type: "notification", level: "info", message: capacityError } }
  ];
  assert.equal(paseoThread(agent("a"), "host", entries).error, null);
});

test("Paseo failure details are bounded and redacted without replacing the assistant report", () => {
  const secret = "sk-" + "test".repeat(10);
  const message = capacityError + " key=" + secret + " ".repeat(9000);
  const row = paseoThread(agent("a"), "host", [
    { item: { type: "assistant_message", text: "Work in progress." } }, errorEntry(message)
  ]);
  assert.equal(row.error?.kind, "model-limit");
  assert.equal(row.error.text.includes(secret), false);
  assert.match(row.error.text, /\[redacted\]/);
  assert.ok(row.error.text.length <= 1000);
  assert.equal(row.lastAgentFull, "Work in progress.");
  assert.equal(row.meta.conversation.length, 1);
});

test("Paseo relative quota reset uses the failure time", () => {
  const message = "Individual quota reached. Resets in 2h.";
  for (const extra of [{}, { status: "error", lastError: message }]) {
    const row = paseoThread(agent("a", { updatedAt: laterAt, ...extra }), "host", [errorEntry(message)]);
    assert.equal(row.error?.kind, "usage-limit");
    assert.equal(row.error.resetAt, "2026-01-01T02:10:00.000Z");
  }
});
