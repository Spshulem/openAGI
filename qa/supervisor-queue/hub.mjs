#!/usr/bin/env node
// Cross-device Supervisor chat QA hub (synthetic). Starts an isolated OpenAGI
// hub with a harmless model and one paired phone, then records what the hub
// received and ran, so Mac and iPhone clients can be driven against it:
//
//   node qa/supervisor-queue/hub.mjs --host 192.168.1.110 --port 47811 --out /tmp/qa-run
//
// The model never calls a tool. "[slow]" in a message makes it take
// --slow-ms (stopping early if the turn is interrupted); anything else is
// answered at once with "Ack: <text>".
//
// Writes into --out:
//   hub.json         url, owner token, phone node id and token (test-only)
//   calls.jsonl      execution receipts: one line per model call, in order
//   records.jsonl    every stored user/assistant record of the shared
//                    Supervisor conversation, as it lands (with requestId)
//   events.jsonl     /events broadcasts about the conversation
// Nothing touches ~/.openagi: the data dir lives under --out.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createDurableRuntime, createHostedInterface } from "../../src/index.js";
import { NodeRegistry } from "../../src/node-registry.js";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith("--")) pairs.push([value.slice(2), all[index + 1]]);
  return pairs;
}, []));
const out = path.resolve(args.out ?? "/tmp/openagi-supervisor-queue-qa");
const host = args.host ?? "127.0.0.1";
const port = Number(args.port ?? 47811);
const slowMs = Number(args["slow-ms"] ?? 20_000);
fs.mkdirSync(out, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(out, "data-"));
const ownerToken = crypto.randomBytes(24).toString("base64url");
const phone = { id: `mobile:qa-${crypto.randomBytes(4).toString("hex")}`, token: crypto.randomBytes(32).toString("base64url") };
const nodeRegistry = new NodeRegistry({ dir: path.join(dataDir, "nodes") });
nodeRegistry.enroll(phone.id, phone.token, { platform: "mobile", name: "QA iPhone" });

const append = (file, entry) => fs.appendFileSync(path.join(out, file), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
const runtime = createDurableRuntime({ dataDir });
let callCount = 0;
runtime.agentHost.modelProvider = {
  name: "qa-harmless", model: "qa-harmless", isConfigured: () => true,
  async generate(request) {
    const n = ++callCount;
    const requestId = request.context?.requestId ?? null;
    append("calls.jsonl", { call: n, phase: "start", input: request.input, requestId });
    if (String(request.input).includes("[slow]")) {
      const signal = request.context?.signal;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, slowMs);
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      }).catch((error) => { append("calls.jsonl", { call: n, phase: "stopped", requestId }); throw error; });
    }
    append("calls.jsonl", { call: n, phase: "end", requestId });
    return { id: `qa_${n}`, text: `Ack: ${request.input}`, provider: "qa", model: "qa-harmless", toolCalls: [] };
  }
};

// Every stored record of the shared conversation, as it lands.
const SESSION = "devices:supervisor:main";
const appendMessage = runtime.agentHost.store.appendMessage.bind(runtime.agentHost.store);
runtime.agentHost.store.appendMessage = (sessionId, message) => {
  const session = appendMessage(sessionId, message);
  if (sessionId === SESSION) {
    const last = session.messages.at(-1);
    append("records.jsonl", {
      id: last?.id, role: last?.role, text: String(last?.content ?? "").slice(0, 300),
      requestId: last?.metadata?.requestId ?? null, sourceName: last?.metadata?.sourceName ?? null,
      sourceNodeId: last?.metadata?.sourceNodeId ?? null, status: last?.metadata?.status ?? null, code: last?.metadata?.code ?? null
    });
  }
  return session;
};
runtime.events?.on?.("conversation.queue", (data) => append("events.jsonl", { event: "conversation.queue", data }));

// Warm the runtime (its first turn loads stores synchronously) so the run
// measures queueing, not start-up. A private session; not the shared thread.
await runtime.agentHost.handleMessage({ text: "qa warm-up", channel: "local", from: "qa", sessionId: "qa:warm-up" });

const app = createHostedInterface(runtime, { host, port, authToken: ownerToken, dataDir, nodeRegistry, tickerMs: 60_000 });
const { url } = await app.listen();
fs.writeFileSync(path.join(out, "hub.json"), JSON.stringify({ url, ownerToken, phone, slowMs, dataDir }, null, 2));
process.stdout.write(`${JSON.stringify({ url, out })}\n`);
const stop = async () => { await app.close().catch(() => {}); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
