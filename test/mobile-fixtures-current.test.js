// test/mobile-fixtures-current.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mobile", "fixtures");
const keys = (value) => Object.keys(value).sort();

// The phone clients decode these files in their own test suites. If the daemon
// changes shape, that must fail here in seconds rather than on a phone weeks
// later.
test("the summary fixture still matches what the daemon produces", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-fixdrift-"));
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, tickerMs: 0, dataDir, authToken: null });
  const listened = await app.listen();
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  try {
    runtime.tasks.add({ queue: "user", title: "Ship the widget", bucket: "today", priority: 80 });
    const live = await (await fetch(`${base}/mobile/summary`)).json();
    const stored = JSON.parse(fs.readFileSync(path.join(fixtures, "summary-populated.json"), "utf8"));
    assert.deepEqual(keys(live), keys(stored));
    assert.deepEqual(keys(live.counts), keys(stored.counts));
    assert.deepEqual(keys(live.today[0]), keys(stored.today[0]));
    assert.deepEqual(keys(live.brief), keys(stored.brief));
  } finally { await app.close(); }
});
