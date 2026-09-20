// Fixtures are generated from a real daemon, never hand-written: a client
// tested against an imagined response is a client that fails on first contact.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

// The exchange response echoes back whatever nodeToken it is given, so a
// fixture that feeds it a real crypto.randomBytes() value would ship a live-
// shaped credential in the repo. Feed it this obviously synthetic 43-char
// placeholder instead — it still satisfies the daemon's token-shape regex
// (/^[a-zA-Z0-9_-]{43}$/) so the fixture still exercises real validation.
const FIXTURE_NODE_TOKEN = "FIXTURE-SYNTHETIC-NODE-TOKEN-NOT-REAL-00000";

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mobile", "fixtures");
fs.mkdirSync(outDir, { recursive: true });

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-fixtures-"));
const runtime = createDurableRuntime({ dataDir });
const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, tickerMs: 0, dataDir, authToken: null });
const listened = await app.listen();
const base = listened.url ?? `http://127.0.0.1:${listened.port}`;

const write = (name, value) => fs.writeFileSync(path.join(outDir, name), JSON.stringify(value, null, 2) + "\n");

write("summary-empty.json", await (await fetch(`${base}/mobile/summary`)).json());

runtime.tasks.add({ queue: "user", title: "Ship the widget", bucket: "today", priority: 80 });
runtime.tasks.add({ queue: "user", title: "Renew the domain", bucket: "today", priority: 40, dueDate: "2020-01-01T00:00:00.000Z" });
runtime.tasks.add({ queue: "user", title: "Read the whitepaper", bucket: "this_week", priority: 20 });

write("summary-populated.json", await (await fetch(`${base}/mobile/summary`)).json());
write("tasks-list.json", await (await fetch(`${base}/tasks?queue=user`)).json());
write("pending-actions.json", await (await fetch(`${base}/pending-actions`)).json());

const { code } = await (await fetch(`${base}/nodes/enrollment-code`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ platform: "mobile" })
})).json();
write("enroll-exchange.json", await (await fetch(`${base}/nodes/enroll/exchange`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({
    code, platform: "mobile",
    nodeId: "mobile:fixture-node",
    nodeToken: FIXTURE_NODE_TOKEN,
    name: "Fixture Phone"
  })
})).json());

await app.close();
console.log(`wrote fixtures to ${outDir}`);
