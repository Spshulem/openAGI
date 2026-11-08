import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createPaseoSource, paseoThread, hostApi, withPaseo } from "../src/fleet/sources/paseo.js";
import { deliverPaseo } from "../src/fleet/paseo-delivery.js";
import { mergeThreads } from "../src/fleet/classify.js";
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
