import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ensureDir, writeJsonAtomic } from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";
import { G2ChannelError } from "./integrations/g2-channel.js";

const WINDOW_MS = 24 * 60 * 60 * 1000;
const ACTIVE = new Set(["accepted", "working"]);
const STAGES = new Set(["transcribing", "transcribed", "accepted", "routing", "thinking", "model", "tool", "tool-complete"]);
const hash = value => createHash("sha256").update(value).digest("hex");
const fail = (code, status, message) => new G2ChannelError(code, status, message);

// Single-main coordinator. Receipts are claims, not a queue: disconnected or
// restarted work is NEVER automatically replayed. Audio stays in the invocation
// closure only. External effects cannot be rolled back or made exactly-once here.
export class G2Requests {
  constructor({ channel, dir, now = Date.now, write = writeJsonAtomic, sweepMs = 1000, onCancel } = {}) {
    this.channel = channel; this.now = now; this.write = write; this.onCancel = onCancel;
    this.dir = dir ?? path.join(resolveDataDir(), "g2-requests");
    this.records = new Map(); this.running = new Map(); this.closed = false; this.storageFailed = false;
    ensureDir(this.dir);
    const files = fs.readdirSync(this.dir).filter(f => /^[a-f0-9]{64}\.json$/.test(f));
    if (files.length > 512) throw fail("request_storage_unavailable", 503, "Request recovery needs attention on main.");
    for (const file of files) {
      const location = path.join(this.dir, file);
      if (fs.statSync(location).size > 256 * 1024) throw fail("request_storage_unavailable", 503, "Request recovery needs attention on main.");
      const record = JSON.parse(fs.readFileSync(location, "utf8"));
      if (record.version !== 1 || !Number.isFinite(record.createdAt) || file !== `${this.key(record.nodeId, record.id)}.json`)
        throw fail("request_storage_unavailable", 503, "Request recovery needs attention on main.");
      if (record.expiresAt < this.now()) { fs.unlinkSync(location); continue; }
      if (ACTIVE.has(record.state)) {
        const completed = this.completedMessage(record);
        Object.assign(record, completed ? { state: "completed", result: { question: record.question ?? "", reply: completed.content.slice(0, 32000), sessionId: record.sessionId } }
          : { state: "unconfirmed", message: "Main restarted. Check this conversation before sending another request; actions may have completed." });
        record.revision++; this.persist(record);
      }
      this.records.set(this.key(record.nodeId, record.id), record);
    }
    this.timer = sweepMs ? setInterval(() => this.sweep(), sweepMs) : null;
    this.timer?.unref?.();
  }

  key(nodeId, id) { return hash(JSON.stringify([nodeId, id])); }
  checkId(id) {
    if (typeof id !== "string" || !/^\d{13}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
      throw fail("invalid_request_id", 400, "A fresh request identity is required.");
    const created = Number(id.split("_")[0]);
    if (created < this.now() - WINDOW_MS || created > this.now() + 60_000)
      throw fail("request_expired", 410, "Recovery expired or the phone clock is incorrect. Check History before sending again.");
    return created;
  }
  persist(record) {
    try { this.write(path.join(this.dir, `${this.key(record.nodeId, record.id)}.json`), record); }
    catch { this.storageFailed = true; throw fail("request_storage_unavailable", 503, "Main could not save request recovery. Nothing new was sent; check main storage."); }
  }
  public(record) {
    const { id, state, revision, createdAt, expiresAt, deadline, sessionId, question, stage, tool, text, result, message, events } = record;
    return structuredClone({ id, state, revision, createdAt, expiresAt, deadline, sessionId, question, stage, tool, text, result, message, events });
  }
  get(nodeId, id) {
    this.channel.assertEnrolled(nodeId); this.checkId(id); this.sweep();
    const record = this.records.get(this.key(nodeId, id));
    if (!record) throw fail("request_not_found", 404, "Main has not accepted this request. The saved question can be sent with the same identity.");
    return this.public(record);
  }
  submit(nodeId, id, body) {
    this.channel.assertEnrolled(nodeId); const createdAt = this.checkId(id);
    if (this.closed || this.storageFailed) throw fail("request_storage_unavailable", 503, "Main request recovery is unavailable. Check main before retrying.");
    const payload = validateRequest(body);
    const digest = hash(JSON.stringify(payload)), key = this.key(nodeId, id);
    this.sweep();
    const existing = this.records.get(key);
    if (existing) {
      if (existing.digest !== digest) throw fail("request_conflict", 409, "This request identity already belongs to a different question.");
      return this.public(existing);
    }
    const own = [...this.records.values()].filter(r => r.nodeId === nodeId);
    if (this.records.size >= 512 || own.length >= 100 || this.running.size >= 16 || own.some(r => ACTIVE.has(r.state)))
      throw fail("request_busy", 429, "Another question is active or the daily recovery limit was reached. Check History first.");
    const sessionId = this.channel.sessionIdFor(nodeId, payload.conversationId, payload.continuation);
    const record = { version: 1, id, nodeId, digest, sessionId, state: "accepted", revision: 1,
      createdAt, expiresAt: createdAt + WINDOW_MS, deadline: this.now() + 300_000,
      question: payload.text ?? "", stage: "accepted", tool: "", text: "", events: [], sequence: 0 };
    this.persist(record); // Must succeed before an agent/transcription call.
    this.records.set(key, record);
    const controller = new AbortController(); this.running.set(key, controller);
    void Promise.resolve().then(async () => {
      if (!ACTIVE.has(record.state) || controller.signal.aborted || this.closed) { this.running.delete(key); return; }
      try {
        this.channel.assertEnrolled(nodeId);
        record.state = "working"; let lastSaved = 0;
        const update = () => {
          record.revision++;
          if (this.now() - lastSaved >= 750) { this.persist(record); lastSaved = this.now(); }
        };
        const result = await this.channel.ask(payload, nodeId, {
          requestId: id, continuation: payload.continuation, signal: controller.signal,
          onProgress: progress => {
            if (!ACTIVE.has(record.state)) return;
            try {
              this.channel.assertEnrolled(nodeId);
              if (STAGES.has(progress.stage)) record.stage = progress.stage;
              record.tool = typeof progress.tool === "string" ? progress.tool.replace(/[^\w.:-]/g, "").slice(0, 100) : "";
              if (STAGES.has(progress.stage)) {
                record.events.push({ seq: ++record.sequence, stage: record.stage, tool: record.tool });
                record.events = record.events.slice(-80);
              }
              if (typeof progress.question === "string") record.question = progress.question.slice(0, 4000);
              update();
            } catch { this.stop(record, "unconfirmed", "Progress could not be saved or access changed. Check main before repeating actions."); }
          },
          onTextDelta: delta => {
            if (!ACTIVE.has(record.state) || typeof delta.text !== "string") return;
            record.text = ((delta.reset ? "" : record.text) + delta.text).slice(0, 32000);
            try { update(); } catch { this.stop(record, "unconfirmed", "Main could not save progress. Check History before repeating actions."); }
          }
        });
        this.channel.assertEnrolled(nodeId);
        if (!ACTIVE.has(record.state) || controller.signal.aborted) return;
        record.result = { question: String(result.question ?? record.question).slice(0, 4000), reply: String(result.reply ?? "").slice(0, 32000), sessionId };
        record.text = "";
        record.state = "completed"; record.revision++; this.persist(record);
      } catch (error) {
        if (!ACTIVE.has(record.state)) return;
        const completed = this.completedMessage(record);
        if (completed) {
          record.state = "completed"; record.result = { question: record.question, reply: completed.content.slice(0, 32000), sessionId };
        } else {
          record.state = "unconfirmed";
          record.message = error instanceof G2ChannelError ? error.message : "The question did not finish. Check History before trying again; some actions may have completed.";
        }
        record.revision++; try { this.persist(record); } catch { /* durable claim remains; never replay */ }
      } finally { this.running.delete(key); }
    });
    return this.public(record);
  }
  completedMessage(record) {
    try {
      return this.channel.agentHost?.store?.getSession(record.sessionId)?.messages?.findLast(m =>
        m.role === "assistant" && m.channel === "g2" && m.metadata?.requestId === record.id && m.metadata?.status !== "failed" && typeof m.content === "string");
    } catch { return null; }
  }
  stop(record, state, message) {
    if (!ACTIVE.has(record.state)) return;
    record.state = state; record.message = message; record.revision++;
    this.running.get(this.key(record.nodeId, record.id))?.abort();
    // Keep the running slot until the underlying promise settles. An executor
    // that ignores abort must not admit an unbounded series of replacement jobs.
    try { this.persist(record); } catch { /* fail closed on new admissions */ }
    try { Promise.resolve(this.onCancel?.(record)).catch(() => {}); } catch { /* main owns authority */ }
  }
  cancel(nodeId, id) {
    this.get(nodeId, id);
    const record = this.records.get(this.key(nodeId, id));
    this.stop(record, "cancelled", "Cancelled. Actions already completed are not undone.");
    return this.public(record);
  }
  sweep() {
    for (const [key, record] of this.records) {
      if (ACTIVE.has(record.state)) {
        try { this.channel.assertEnrolled(record.nodeId); }
        catch { this.stop(record, "cancelled", "This G2 connection was revoked."); }
        if (this.now() >= record.deadline) this.stop(record, "unconfirmed", "The question exceeded five minutes. Check History before repeating actions.");
      }
      if (record.expiresAt < this.now() && !this.running.has(key)) {
        try { fs.unlinkSync(path.join(this.dir, `${key}.json`)); this.records.delete(key); }
        catch { this.storageFailed = true; }
      }
    }
  }
  close() {
    this.closed = true; clearInterval(this.timer);
    for (const record of this.records.values()) this.stop(record, "unconfirmed", "Main stopped. Check History before sending another request.");
  }
}

function validateRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(k => !["text", "audioBase64", "conversationId", "continuation", "language"].includes(k)))
    throw fail("invalid_question", 400, "Unsupported question fields.");
  if (typeof body.conversationId !== "string" || !body.conversationId.trim() || body.conversationId.length > 200)
    throw fail("invalid_conversation", 400, "Choose a conversation first.");
  if (body.continuation !== undefined && (typeof body.continuation !== "string" || body.continuation.length > 200))
    throw fail("invalid_conversation", 400, "Invalid conversation reference.");
  const textOnly = typeof body.text === "string";
  if (textOnly ? (!body.text.trim() || body.text.length > 4000 || body.audioBase64 !== undefined)
    : (body.text !== undefined || typeof body.audioBase64 !== "string" || body.audioBase64.length > 1_281_000))
    throw fail("invalid_question", 400, "Send one question of at most 4000 characters or 30 seconds.");
  return { ...(textOnly ? { text: body.text.trim() } : { audioBase64: body.audioBase64 }), conversationId: body.conversationId,
    ...(body.continuation ? { continuation: body.continuation } : {}), ...(typeof body.language === "string" ? { language: body.language.slice(0, 20) } : {}) };
}
