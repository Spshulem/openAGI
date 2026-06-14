// Proactive iMessage extraction.
//
// The bridge captures every incoming text to memory (tagged "imessage"). This
// runs periodically on the main and pulls structured, actionable items out of
// those raw captures so the user doesn't have to ask:
//   • links   → saved to memory (regex, free)
//   • events  → saved to memory (date/time-bearing plans)
//   • follow-ups → created as tasks in the user queue (things the user must do)
//
// Cost-aware by design: links/dates are pure regex (no model). The follow-up /
// event understanding uses the CHEAP "extract" tier (nano) on a batch, and the
// whole pass early-returns for $0 when there are no new messages — so an idle
// agent pays nothing. This is the "scan new data, surface what matters" half of
// the listen-queue idea.

import path from "node:path";
import { readJsonFile, writeJsonAtomic, ensureDir } from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";
import { nowIso } from "./utils.js";

const STATE_FILE = "imessage-extract.json";
const MAX_BATCH = 60; // cap the per-run transcript so a busy day stays cheap
const URL_RE = /https?:\/\/[^\s<>"')]+/gi;

const SYSTEM_PROMPT = [
  "You extract actionable items from a batch of the user's recent text messages.",
  '"Peri" is the AI assistant; "Spencer" is the human owner.',
  "Return STRICT JSON only, no prose:",
  '{"followups":[{"text":"<the action>","who":"<sender if known>","queue":"agent|user","action":"act|draft"}],',
  ' "events":[{"title":"<plan>","when":"<date/time as written>"}]}',
  "Rules:",
  "- followups: only real, specific commitments or direct asks. Not idle chatter.",
  '- queue: "agent" if Peri can handle it itself (reply to a text, look something up, remember a fact,',
  '  draft/introduce); "user" if only Spencer can (in-person, personal decisions, his own accounts).',
  '- action (queue "agent" only): "draft" if completing it SENDS something externally (a text/email/DM) —',
  '  prepare but do not send; "act" if safe to just do (lookup, remember, internal note). Use "act" otherwise.',
  "- events: plans tied to a date/time (dinner Fri 7pm, flight Tuesday, meeting the 15th).",
  "- Be conservative. Use empty arrays if nothing qualifies."
].join("\n");

export class IMessageExtractor {
  constructor({ runtime, dataDir } = {}) {
    this.runtime = runtime;
    this.dataDir = dataDir ?? resolveDataDir();
    this.statePath = path.join(this.dataDir, STATE_FILE);
  }

  _loadState() { return readJsonFile(this.statePath, { lastRun: null }); }
  _saveState(state) { ensureDir(this.dataDir); writeJsonAtomic(this.statePath, state); }

  // Captured iMessages newer than `since`, oldest-first, capped to MAX_BATCH.
  recentMessages(since) {
    const out = [];
    for (const item of this.runtime?.memory?.items?.values?.() ?? []) {
      if (!item.tags?.includes?.("imessage")) continue;
      // skip items we already created (links/events we wrote back to memory)
      if (item.tags.includes("link") || item.tags.includes("event")) continue;
      if (since && item.createdAt <= since) continue;
      out.push(item);
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    return out.slice(-MAX_BATCH);
  }

  async extract() {
    const state = this._loadState();
    const msgs = this.recentMessages(state.lastRun);
    if (msgs.length === 0) return { skipped: true, reason: "no new messages" };

    // 1. Links — pure regex, no model cost.
    const links = [];
    for (const m of msgs) {
      for (const url of String(m.content).match(URL_RE) ?? []) {
        links.push({ url, from: m.tags?.find((t) => t !== "imessage") ?? null });
      }
    }

    // 2. Follow-ups + events — cheap nano pass over the batch.
    let followups = [];
    let events = [];
    const provider = this.runtime?.agentHost?.modelProvider;
    const haveLLM = provider?.isConfigured?.() && provider.constructor.name !== "DeterministicModelProvider";
    if (haveLLM) {
      try {
        const transcript = msgs.map((m) => m.content).join("\n");
        const result = await provider.generate({
          input: transcript,
          task: "extract",
          instructions: SYSTEM_PROMPT,
          agent: { id: "imessage-extractor", name: "imessage-extractor" },
          memoryHits: [], messages: [], tools: [], toolRegistry: null, context: {}
        });
        const parsed = safeJson(result?.text);
        followups = Array.isArray(parsed?.followups) ? parsed.followups : [];
        events = Array.isArray(parsed?.events) ? parsed.events : [];
      } catch { /* extraction is best-effort; links still saved */ }
    }

    // 3. Persist: links + events → memory; follow-ups → tasks.
    let savedLinks = 0, savedEvents = 0, createdTasks = 0;
    for (const l of links) {
      this.runtime?.memory?.remember?.(
        { content: `Link from iMessage${l.from ? ` (${l.from})` : ""}: ${l.url}`, tags: ["imessage", "link"], kind: "fact" },
        { tier: "medium" }
      );
      savedLinks++;
    }
    for (const e of events) {
      if (!e?.title) continue;
      this.runtime?.memory?.remember?.(
        { content: `Event (from iMessage): ${e.title}${e.when ? ` — ${e.when}` : ""}`, tags: ["imessage", "event"], kind: "fact" },
        { tier: "medium" }
      );
      savedEvents++;
    }
    for (const f of followups) {
      if (!f?.text) continue;
      try {
        // Route to the right queue, and tag agent tasks that send externally
        // as `plan-action` (draft-only) so autopilot prepares but never sends.
        const queue = f.queue === "agent" ? "agent" : "user";
        const tags = queue === "agent" && f.action === "draft" ? ["plan-action"] : [];
        this.runtime?.tasks?.add?.(
          { title: f.text, tags, sourceMeta: { from: f.who ?? null, origin: "imessage" } },
          { source: "imessage", queue }
        );
        createdTasks++;
      } catch { /* best effort */ }
    }

    this._saveState({ lastRun: nowIso() });
    return { processed: msgs.length, links: savedLinks, events: savedEvents, followups: createdTasks };
  }
}

function safeJson(text) {
  if (!text) return null;
  const m = String(text).match(/\{[\s\S]*\}/);
  try { return JSON.parse(m ? m[0] : text); } catch { return null; }
}
