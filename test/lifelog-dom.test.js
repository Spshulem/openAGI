import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";
import { NodeRegistry } from "../src/node-registry.js";

// Optional DOM harness uses the G2 package's existing jsdom dependency.
test("lifelog owner page crosses real HTTP for load, speaker correction, search and deletion", { skip: !process.env.OPENAGI_UI_PACKAGE }, async t => {
  const { JSDOM } = createRequire(path.join(process.env.OPENAGI_UI_PACKAGE, "package.json"))("jsdom");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lifelog-dom-"));
  const registry = new NodeRegistry({ dir: path.join(dir, "nodes") });
  const nodeId = crypto.randomUUID(); registry.enroll(nodeId, "fixture-lifelog-node-token".padEnd(43, "x"), { platform: "even_g2", name: "Fixture glasses" });
  const runtime = createDurableRuntime({ dataDir: dir, registerDefaults: false, integrations: false, skills: false, autoConnectMcp: false });
  const app = createHostedInterface(runtime, { dataDir: dir, nodeRegistry: registry, port: 0, host: "127.0.0.1", tickerMs: 0, authToken: "fixture-lifelog-owner", nodeControlEnabled: false });
  let dom;
  t.after(async () => { dom?.window.close(); await app.close(); runtime.observations?.db?.close(); runtime.vectorStore?.db?.close(); runtime.sessionIndex?.db?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { url } = await app.listen();
  const request = (input, init = {}) => fetch(new URL(input, url), { ...init, headers: { ...init.headers, authorization: "Bearer fixture-lifelog-owner" } });
  const api = async body => { const res = await request("/g2/proactive", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, nodeId }) }); assert.equal(res.status, 200); return res.json(); };
  const consent = await api({ op: "consent", enabled: true, recordingConsent: true });
  await api({ op: "capture", consentId: consent.consent.id, batchId: crypto.randomUUID(), texts: ["I'll send the launch plan.", "We agreed to use blue."], segments: [0, 1].map(speaker => ({ at: Date.now() - 3000, endAt: Date.now(), streamId: "fixture-stream", speaker })) });
  const html = await (await request("/g2/lifelog")).text();
  dom = new JSDOM(html, { url: url + "/g2/lifelog", runScripts: "dangerously", beforeParse(window) { window.fetch = request; window.confirm = () => true; window.prompt = () => "Alex"; } });
  const d = dom.window.document;
  const until = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)); } assert.fail("UI did not settle"); };
  await until(() => d.querySelectorAll("article").length === 1);
  assert.match(d.querySelector("article").textContent, /I'll send the launch plan/);
  const label = [...d.querySelectorAll("button")].find(b => b.textContent === "Label speaker"); label.click();
  await until(() => d.querySelector("article")?.textContent.includes("Alex"));
  d.querySelector("#query").value = "Alex"; d.querySelector("#search").click();
  await until(() => d.querySelector("#status").textContent.includes("1 moments"));
  assert.equal((await api({ op: "lifelog", query: "Alex" })).total, 1);
  const remove = [...d.querySelectorAll("button")].find(b => b.textContent === "Delete moment"); remove.click();
  await until(() => d.querySelector("#status").textContent.includes("0 moments"));
  assert.equal((await api({ op: "lifelog-export" })).moments.length, 0);
});
