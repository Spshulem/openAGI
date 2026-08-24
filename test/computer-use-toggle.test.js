import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { _resetDataDirCache } from "../src/data-dir.js";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

test("computer-use toggle persists to the hosted interface's explicit data directory", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-computer-toggle-"));
  const interfaceDir = path.join(root, "interface");
  const resolvedDir = path.join(root, "globally-resolved");
  fs.mkdirSync(interfaceDir, { recursive: true });
  fs.mkdirSync(resolvedDir, { recursive: true });

  const previousDataDir = process.env.OPENAGI_DATA_DIR;
  const previousComputerUse = process.env.OPENAGI_COMPUTER_USE;
  process.env.OPENAGI_DATA_DIR = resolvedDir;
  delete process.env.OPENAGI_COMPUTER_USE;
  _resetDataDirCache();

  const runtime = createDurableRuntime({ dataDir: interfaceDir });
  const app = createHostedInterface(runtime, {
    host: "127.0.0.1",
    port: 0,
    tickerMs: 0,
    dataDir: interfaceDir,
    authToken: null
  });

  try {
    const listened = await app.listen();
    const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
    const response = await fetch(`${base}/computer-use/toggle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enable: true })
    });

    assert.equal(response.status, 200);
    assert.match(fs.readFileSync(path.join(interfaceDir, ".env"), "utf8"), /OPENAGI_COMPUTER_USE=1/);
    assert.equal(
      fs.existsSync(path.join(resolvedDir, ".env")),
      false,
      "the process-wide resolved directory must not receive another interface's setting"
    );
  } finally {
    await app.close();
    if (previousDataDir === undefined) delete process.env.OPENAGI_DATA_DIR;
    else process.env.OPENAGI_DATA_DIR = previousDataDir;
    if (previousComputerUse === undefined) delete process.env.OPENAGI_COMPUTER_USE;
    else process.env.OPENAGI_COMPUTER_USE = previousComputerUse;
    _resetDataDirCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("computer-use activity is described as readable copy instead of raw JSON", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const source = fs.readFileSync(path.join(root, "src/hosted-interface.js"), "utf8");
  const start = source.indexOf("async function renderComputerUse()");
  const end = source.indexOf("\nasync function renderActivity()", start);
  assert.ok(start >= 0 && end > start, "renderComputerUse source was not found");
  const renderer = source.slice(start, end);

  assert.match(renderer, /const computerActionCopy = \(action\) =>/);
  assert.match(renderer, /redacted character/);
  assert.match(renderer, /Double-click/);
  assert.match(renderer, /button at x/);
  assert.match(renderer, /Drag .* button from x/);
  assert.doesNotMatch(renderer, /JSON\.stringify\(a\.args\)/);
});
