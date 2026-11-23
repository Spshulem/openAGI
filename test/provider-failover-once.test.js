// #332 review: a quota-blocked session with no parsed reset time must not be
// failed over again for the same failure once its 12 h mute expires.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { paseoThread } from "../src/fleet/sources/paseo.js";
import { FleetSupervisor } from "../src/fleet/supervisor.js";

test("auto-failover runs once per failure, not again after the mute expires", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "failover-once-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const agent = { id: "quota-agent-1", title: "Bob chat", status: "running", provider: "codex/gpt-5.4", cwd: "/home/dev/app", createdAt: "2026-11-22T01:00:00.000Z", updatedAt: "2026-11-22T03:00:00.000Z" };
  let entries = [
    { timestamp: "2026-11-22T02:58:00.000Z", item: { type: "user_message", text: "Unify the chat composer." } },
    { timestamp: "2026-11-22T03:00:00.000Z", item: { type: "assistant_message", text: "[System Error] You've hit your usage limit." } }
  ];
  const created = [];
  const factory = () => ({
    connect: async () => {}, close: async () => {},
    hosts: { list: async () => ({ self: { serverId: "srv_x" }, hosts: [] }) },
    agents: {
      ref: () => ({ refresh: async () => {}, current: () => agent, timeline: { refetch: async () => ({ entries }) } }),
      create: async (spec) => { created.push(spec); return { id: `replacement-${created.length}` }; }
    },
    providers: { waitForReady: async () => ({ entries: [
      { provider: "codex", status: "ready", models: [{ id: "gpt-5.4", isDefault: true }] },
      { provider: "claude", status: "ready", models: [{ id: "claude-opus-4-6", isDefault: true }] }
    ] }) }
  });
  let nowMs = Date.parse("2026-11-22T03:05:00.000Z");
  const sup = new FleetSupervisor({
    dataDir: dir,
    runtime: { events: { emit() {} } },
    config: { enabled: true, mode: "auto", paseo: { enabled: true, only: true }, review: { enabled: false } },
    deps: {
      now: () => nowMs,
      paseoFactory: factory,
      listPaseoThreads: async () => [paseoThread(agent, "srv_x", entries, true)],
      fetchPrStates: async () => new Map(),
      executor: { deliver: async (a) => ({ status: "sent", route: a.route, detail: "ok" }), inFlight: () => [], whenIdle: async () => {} }
    }
  });
  const mapped = paseoThread(agent, "srv_x", entries, true);
  assert.equal(mapped.error?.kind, "usage-limit");
  assert.ok(!mapped.error?.resetAt, "no parsed reset time: the 12 h mute applies");

  await sup._tick("timer");
  assert.equal(created.length, 1, "the first scan fails over once");

  nowMs += 13 * 3_600_000; // past the 12 h mute, same unchanged failure
  agent.updatedAt = new Date(nowMs - 5 * 60_000).toISOString(); // metadata churn, no new error
  await sup._tick("timer");
  assert.equal(created.length, 1, "the same failure is not failed over a second time");

  // A genuinely new failure on the old session may fail over again.
  entries = [...entries, { timestamp: new Date(nowMs - 60_000).toISOString(), item: { type: "assistant_message", text: "[System Error] You've hit your usage limit." } }];
  agent.updatedAt = new Date(nowMs - 60_000).toISOString();
  nowMs += 60_000;
  await sup._tick("timer");
  assert.equal(created.length, 2, "a new failure is handled");
});
