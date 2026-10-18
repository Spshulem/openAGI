import path from "node:path";
import { createHash, createHmac } from "node:crypto";
import { ensureDir, readJsonFile, writeJsonAtomic } from "../file-utils.js";
import { resolveDataDir } from "../data-dir.js";
import { matchesSecret } from "./sendblue.js";
import { detectTaskInChat } from "../task-store.js";

export class PebbleWebhook {
  constructor({ runtime, dir = path.join(resolveDataDir(), "pebble"), env = process.env, now = Date.now } = {}) {
    this.runtime = runtime; this.dir = dir; this.env = env; this.now = now; this.inflight = new Map();
    ensureDir(dir);
  }
  status() { return { configured: Boolean(this.env.PEBBLE_WEBHOOK_SECRET), payloadMode: "Transcription only or Both" }; }
  verify(headers, raw) {
    if (!this.env.PEBBLE_WEBHOOK_SECRET || headers["x-index-webhook-version"] !== "1") return false;
    const timestamp = headers["x-index-timestamp"], delivery = headers["x-index-delivery"], trigger = headers["x-index-trigger"];
    if (typeof timestamp !== "string" || !/^\d{10}$/.test(timestamp) || Math.abs(this.now() / 1000 - Number(timestamp)) > 300) return false;
    if (typeof delivery !== "string" || !/^[\w-]{1,200}$/.test(delivery) || !["single-click-hold", "double-click-hold", "test-event"].includes(trigger)) return false;
    const test = headers["x-index-test"] === "true";
    const prefix = `v1\n${timestamp}\n${delivery}\n${trigger}\n${test ? "1" : "0"}\n`;
    const expected = createHmac("sha256", this.env.PEBBLE_WEBHOOK_SECRET).update(prefix).update(raw).digest("hex");
    return matchesSecret(headers["x-index-signature"], expected);
  }
  async handle(headers, raw) {
    if (!this.verify(headers, raw)) return { status: 401, body: { error: "invalid_pebble_signature" } };
    const key = createHash("sha256").update(headers["x-index-delivery"]).digest("hex");
    if (this.inflight.has(key)) return this.inflight.get(key);
    const work = this.ingest(key, headers, raw);
    this.inflight.set(key, work);
    try { return await work; } finally { this.inflight.delete(key); }
  }
  async ingest(key, headers, raw) {
    const receiptPath = path.join(this.dir, `${key}.json`);
    if (readJsonFile(receiptPath, null)) return { status: 200, body: { duplicate: true } };
    let form;
    try { form = await new Response(raw, { headers: { "content-type": headers["content-type"] ?? "" } }).formData(); }
    catch { return { status: 400, body: { error: "invalid_multipart" } }; }
    // A test event must never create a memory or task.
    if (headers["x-index-test"] === "true" || headers["x-index-trigger"] === "test-event" || form.get("test") === "true") return { status: 200, body: { ok: true, test: true } };
    const text = form.get("transcription"), recordedAt = form.get("recordedAt");
    if (typeof text !== "string" || !text.trim() || text.length > 16000) return { status: 422, body: { error: "transcription_required", message: "Select Transcription only or Both in Pebble webhook settings (up to 16000 characters)." } };
    if (form.get("client") !== "ring" || typeof recordedAt !== "string" || !/^\d{13}$/.test(recordedAt) || !Number.isFinite(Number(recordedAt))) return { status: 400, body: { error: "invalid_recording" } };
    const signal = { id: `pebble-${key}`, source: "pebble-index", type: "voice-memo", summary: text.slice(0, 240), content: text,
      tags: ["pebble", "voice-memo"], metadata: { recordedAt: new Date(Number(recordedAt)).toISOString(), trigger: headers["x-index-trigger"] },
      urgency: 0.3, impact: 0.4, novelty: 0.6, repetition: 0.2, risk: 0.2, confidence: 0.8, specificity: 0.6 };
    // Store speech as data, never as an owner principal or executable prompt.
    // No MCP calls, email, computer input or external action can run here.
    const remembered = this.runtime.memory.remember({ source: signal.source, scope: "main", content: text, tags: signal.tags, metadata: signal.metadata }, { source: signal.source });
    const detected = detectTaskInChat(text);
    const task = detected && this.runtime.tasks?.add ? this.runtime.tasks.add({ title: detected.title, sourceId: signal.id, sourceMeta: signal.metadata }, { source: "pebble-index", queue: "user" }) : null;
    const result = { accepted: true, memoryId: remembered?.id ?? null, taskId: task?.id ?? null, scheduled: false };
    writeJsonAtomic(receiptPath, result);
    return { status: 202, body: result };
  }
}
