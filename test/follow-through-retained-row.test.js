// #332 review: when a session source fails, the row kept from the previous
// scan must not settle a new follow-through watch as "replied".
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FleetSupervisor } from "../src/fleet/supervisor.js";

test("a retained pre-send row does not resolve a follow-through watch", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ftw-retained-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const start = Date.parse("2026-11-22T18:00:00.000Z");
  let nowMs = start;
  const sup = new FleetSupervisor({ dataDir: dir, runtime: { events: { emit() {} } }, config: { enabled: false, mode: "auto" }, deps: { now: () => nowMs } });
  const row = {
    key: "paseo:srv.sess_w", kind: "paseo", title: "Ship fix", agentStatus: "idle",
    lastAgentAt: "2026-11-22T17:50:00.000Z", lastActivityAt: "2026-11-22T17:50:00.000Z",
    lastAgentText: "Earlier reply to the previous request.", prRefs: [], meta: {}
  };
  sup.lastThreads.set(row.key, row);
  const watch = sup.registerFollowThroughWatch(row, "Now also add the tests", { source: "owner-message" });
  assert.ok(watch?.id);

  // Two minutes later the source fails: the current scan has no row for it,
  // only the retained pre-send one in lastThreads.
  nowMs = start + 2 * 60_000;
  const outcomes = await sup.reconcileFollowThroughWatches({ byKey: new Map(), items: [], started: nowMs });
  assert.deepEqual(outcomes, []);
  assert.ok(sup.store.openFollowThroughWatches().some((w) => w.id === watch.id), "the watch stays open");

  // Seen again in a real scan with a reply after the send: now it settles.
  nowMs = start + 4 * 60_000;
  const fresh = { ...row, lastAgentAt: new Date(start + 3 * 60_000).toISOString(), lastAgentText: "Tests added and passing." };
  await sup.reconcileFollowThroughWatches({ byKey: new Map([[row.key, fresh]]), items: [], started: nowMs });
  assert.ok(!sup.store.openFollowThroughWatches().some((w) => w.id === watch.id), "a real reply settles it");
});
