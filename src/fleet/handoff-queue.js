// Owner-approved handoffs that could not go out because the target chat's
// Paseo host was offline. Each is kept here, on disk, before anything else
// happens to it, shown as waiting, and sent once that exact chat's host is
// back, without asking the owner to approve again. It counts as delivered
// only when the send to that chat is confirmed. One that can no longer be
// sent safely (too old, chat gone, the owner wrote to the chat since) stops
// with a specific blocker instead of being sent.
//
// key: the approval's stable identity (its pending-action id when it came
// from an approval card). The same key is never queued or delivered twice.
import fs from "node:fs";
import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "../file-utils.js";

export const HANDOFF_TTL_MS = 24 * 60 * 60_000;
// After a failed resume attempt, the next waits at least this long.
export const HANDOFF_RETRY_MS = 60_000;
const KEEP_FINISHED = 50;
const SNIPPET = 160;

export class HandoffQueue {
  constructor({ dir, now = () => Date.now() }) {
    this.file = path.join(dir, "handoffs.json");
    this.now = now;
    const saved = readJsonFile(this.file, null);
    this.entries = Array.isArray(saved?.entries) ? saved.entries : [];
  }

  get(key) {
    return key ? this.entries.find((entry) => entry.key === key) ?? null : null;
  }

  waiting() {
    return this.entries.filter((entry) => entry.status === "waiting");
  }

  // Queues one handoff, or returns the one already queued under this key.
  // A newer approved handoff to the same chat replaces one still waiting
  // there: the owner approved again, and the latest instruction wins, so
  // the chat never receives both.
  enqueue({ key, threadKey, serverId = null, message, images = null, reason, createdAt = null, supersedeExisting = true, status = "waiting" }) {
    const existing = this.get(key);
    if (existing) return { entry: existing, created: false };
    const at = new Date(this.now()).toISOString();
    const created = typeof createdAt === "string" && createdAt ? createdAt : at;
    if (supersedeExisting) {
      for (const entry of this.entries) {
        if (entry.status === "waiting" && entry.threadKey === threadKey) {
          entry.status = "superseded";
          entry.updatedAt = at;
          entry.detail = `replaced by a newer approved handoff (${key})`;
        }
      }
    }
    const entry = {
      key, threadKey, serverId, message,
      ...(Array.isArray(images) && images.length ? { images } : {}),
      status, createdAt: created, updatedAt: at, attempts: 0, nextTryAt: at,
      detail: reason
    };
    this.entries.push(entry);
    this.save();
    return { entry, created: true };
  }

  // A newer owner send to this chat was processed (whatever its
  // outcome, keyed or unkeyed): earlier waiting handoffs there are obsolete
  // and never sent.
  supersedeWaiting(threadKey, exceptKey = null) {
    const at = new Date(this.now()).toISOString();
    let changed = 0;
    for (const entry of this.entries) {
      if (entry.status === "waiting" && entry.threadKey === threadKey && (!exceptKey || entry.key !== exceptKey)) {
        entry.status = "superseded";
        entry.updatedAt = at;
        entry.detail = exceptKey ? `replaced by a newer approved send (${exceptKey})` : "replaced by a newer owner send";
        delete entry.images;
        changed += 1;
      }
    }
    if (changed) this.save();
    return changed;
  }

  update(key, patch) {
    const entry = this.get(key);
    if (!entry) return null;
    Object.assign(entry, patch, { updatedAt: new Date(this.now()).toISOString() });
    // A finished handoff no longer needs its text or images on disk.
    if (!["waiting", "queued"].includes(entry.status)) { delete entry.images; }
    this.prune();
    this.save();
    return entry;
  }

  prune() {
    const finished = this.entries.filter((entry) => !["waiting", "queued"].includes(entry.status));
    if (finished.length <= KEEP_FINISHED) return;
    const drop = new Set(finished.slice(0, finished.length - KEEP_FINISHED));
    this.entries = this.entries.filter((entry) => !drop.has(entry));
  }

  // What the state shows: no full text, no images.
  summary() {
    return this.entries.slice(-20).map(({ message, images, ...rest }) => ({
      ...rest,
      snippet: String(message ?? "").slice(0, SNIPPET)
    }));
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeJsonAtomic(this.file, { entries: this.entries });
  }
}

// Why a waiting handoff must never be sent, or null. thread: the last
// scan's view of the chat, or null when it is not listed (an offline host's
// chats may not be, after a restart): that one keeps waiting until the TTL.
export function handoffStaleReason(entry, thread, now) {
  const age = now - Date.parse(entry.createdAt);
  if (Number.isFinite(age) && age > HANDOFF_TTL_MS) {
    return `waited over ${Math.round(HANDOFF_TTL_MS / 3_600_000)} h for the chat's host; not sent. Approve it again if it still applies.`;
  }
  if (!thread) return null;
  if (thread.archived) return "the target chat was archived; not sent.";
  const ownerAt = Date.parse(thread.ownerSpokeAt ?? "");
  if (Number.isFinite(ownerAt) && ownerAt > Date.parse(entry.createdAt)) {
    return "you wrote to that chat after approving this handoff, so it was not sent on top of your newer words. Approve it again if it still applies.";
  }
  return null;
}
