import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { _resetDataDirCache } from "../src/data-dir.js";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

test("POST /persona writes persona.md and renames the main agent live; requires the owner token", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-persona-"));
  const saved = process.env.OPENAGI_DATA_DIR;
  process.env.OPENAGI_DATA_DIR = dir;
  _resetDataDirCache();
  const runtime = createDurableRuntime({ dataDir: dir });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, tickerMs: 0, dataDir: dir, authToken: "owner" });
  const listened = await app.listen();
  t.after(async () => {
    await app.close();
    if (saved === undefined) delete process.env.OPENAGI_DATA_DIR; else process.env.OPENAGI_DATA_DIR = saved;
    _resetDataDirCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  const post = (body, token = "owner") => fetch(`${base}/persona`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });

  assert.equal((await post({ name: "Pip" }, "wrong")).status, 401);
  assert.equal((await post({ name: "  " })).status, 400);

  const res = await post({ name: "Pip\n# evil", focus: "Groceries and errands" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).name, "Pip evil");
  const text = fs.readFileSync(path.join(dir, "persona.md"), "utf8");
  assert.match(text, /^# Pip evil\n/);
  assert.match(text, /What I help with: Groceries and errands/);
  assert.equal(runtime.agentHost?.store.getAgent?.("main")?.name ?? "Pip evil", "Pip evil");
});
