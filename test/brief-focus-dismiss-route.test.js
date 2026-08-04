// test/brief-focus-dismiss-route.test.js
//
// The dismiss action is DECLARATIVE — the composer sends method+path+body and
// the Mac client dispatches it verbatim. So the thing worth testing is exactly
// that: take the action off GET /brief/today, fire it as sent, and check the
// row is gone on the refetch. A composer-only test would pass happily while the
// route 404s, which is the shipped-a-dead-button failure this whole surface
// exists to avoid.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";
import { planDateKey } from "../src/daily-planner.js";

async function bootApp(dataDir) {
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, tickerMs: 0, dataDir, authToken: null });
  const listened = await app.listen();
  return { runtime, app, base: listened.url ?? `http://127.0.0.1:${listened.port}` };
}

/// Today's plan artifact, as the 08:00 cron writes it — advice-shaped focus with
/// no taskId, which is what the real install produced on 2026-08-03.
///
/// Written AFTER the app boots, deliberately: the runtime registers a
/// "daily-plan-morning" cron job whose handler rewrites this exact file, and
/// while `tickerMs: 0` means nothing should drain the queue here, a fixture that
/// cannot be clobbered by a boot-time write is worth more than one that relies
/// on that staying true.
function writeAdvicePlan(dataDir, titles) {
  const dateISO = planDateKey(new Date());
  fs.mkdirSync(path.join(dataDir, "plan"), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "plan", `${dateISO}.json`),
    JSON.stringify({ dateISO, focus: titles.map((title) => ({ title, taskId: null, why: "nothing is scheduled" })) })
  );
  return dateISO;
}

const ADVICE = "Keep the day intentionally open — no scheduled meetings, deadlines, or carried-over commitments";

test("the advice focus row's dismiss works when dispatched verbatim, and it stays gone", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-dismissroute-"));
  const { app, base } = await bootApp(dataDir);
  try {
    const dateISO = writeAdvicePlan(dataDir, [ADVICE, "Protect one meaningful work block"]);
    const first = (await (await fetch(`${base}/brief/today`)).json()).items.find((i) => i.kind === "focus");
    assert.ok(first, "premise: the plan's advice is pinned at the top");
    assert.equal(first.title, ADVICE);

    const dismiss = first.actions.find((a) => a.id === "dismiss");
    assert.ok(dismiss, `the row must be clearable; actions were ${JSON.stringify(first.actions.map((a) => a.id))}`);
    assert.ok(first.actions.some((a) => a.id === "add"), "and adding it as a task is still on offer");

    const applied = await fetch(`${base}${dismiss.path}`, {
      method: dismiss.method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(dismiss.body ?? {})
    });
    assert.equal(applied.status, 200, "the action must work exactly as sent");

    const after = (await (await fetch(`${base}/brief/today`)).json()).items.filter((i) => i.kind === "focus");
    assert.ok(!after.some((i) => i.title === ADVICE), "the dismissed row came back");
    assert.equal(after[0]?.title, "Protect one meaningful work block", "the freed slot goes to the next focus");

    // Persisted where the composer looks, under the local day it belongs to.
    const record = JSON.parse(fs.readFileSync(path.join(dataDir, "plan", "dismissed", `${dateISO}.json`), "utf8"));
    assert.equal(record.date, dateISO);
    assert.equal(record.focus.length, 1);
  } finally { await app.close(); }
});

test("a dismiss with no key is refused, not silently accepted", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-dismissroute2-"));
  const { app, base } = await bootApp(dataDir);
  try {
    writeAdvicePlan(dataDir, [ADVICE]);
    const res = await fetch(`${base}/brief/focus/dismiss`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}"
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.ok, false);
    const after = (await (await fetch(`${base}/brief/today`)).json()).items.filter((i) => i.kind === "focus");
    assert.equal(after.length, 1, "and nothing was hidden");
  } finally { await app.close(); }
});
