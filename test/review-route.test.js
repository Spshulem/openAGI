import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

async function boot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-review-route-"));
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, {
    host: "127.0.0.1",
    port: 0,
    tickerMs: 0,
    dataDir,
    authToken: null
  });
  const listened = await app.listen();
  return { dataDir, runtime, app, base: listened.url ?? `http://127.0.0.1:${listened.port}` };
}

test("GET /review-queue exposes searchable rows and validates query input", async (t) => {
  const { dataDir, runtime, app, base } = await boot();
  t.after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const task = runtime.tasks.add({
    queue: "user",
    title: "Needle task",
    description: "Find me through the review endpoint",
    bucket: "today"
  });

  const response = await fetch(`${base}/review-queue?kind=tasks&q=needle&limit=1`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.total, 1);
  assert.equal(body.items[0].id, task.id);
  assert.equal(body.items[0].deepLink, `/?tab=tasks&task=${encodeURIComponent(task.id)}`);
  assert.equal("editValue" in body.items[0], false);

  const invalid = await fetch(`${base}/review-queue?kind=secrets`);
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /unknown review kind/);
});

test("served dashboard recognizes and renders the Review tab", async (t) => {
  const priorKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-only-not-a-real-key";
  const { dataDir, app, base } = await boot();
  t.after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = priorKey;
  });

  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /data-tab="review"/);
  assert.match(html, /async function renderReview/);
  assert.match(html, /else if \(tab === "review"\)/);
  assert.match(html, /new Set\(\["chat","tasks","review"/);
  assert.match(html, /if \(run\.status === "ran"\)/, "only a completed manual run is celebrated");
  assert.match(
    html,
    /throw new Error\(run\.error \|\| run\.message \|\| "Cleanup did not start/,
    "failed and timed-out manual runs surface their terminal error"
  );
  assert.match(html, /const pollDeadline = Date\.now\(\) \+ 11 \* 60 \* 1000/);
  assert.match(html, /const finalResult = await fetchJson\(run\.poll\)/);
  assert.match(html, /button\.disabled = false/);
  const script = html.match(/<script[^>]*>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script, "dashboard includes its client script");
  assert.doesNotThrow(() => new Function(script), "generated dashboard JavaScript parses");
});
