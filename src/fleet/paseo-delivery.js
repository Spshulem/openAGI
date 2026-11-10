import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { writeJsonAtomic } from "../file-utils.js";
import { withPaseo, hostApi } from "./sources/paseo.js";

const active = new Set();

function nonEmpty(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function timelineCursor(history) {
  const epoch = nonEmpty(history?.epoch);
  const seq = Number.isInteger(history?.endCursor?.seq)
    ? history.endCursor.seq
    : Number.isInteger(history?.window?.maxSeq) ? history.window.maxSeq : null;
  return epoch && seq !== null ? { epoch, seq } : null;
}

function receiptIds(receipt) {
  return new Set([
    receipt?.messageId,
    receipt?.clientMessageId,
    receipt?.providerMessageId,
  ].map(nonEmpty).filter(Boolean));
}

function entryIds(entry) {
  return [
    entry?.item?.messageId,
    entry?.item?.clientMessageId,
    entry?.providerMessageId,
    entry?.item?.providerMessageId,
  ].map(nonEmpty).filter(Boolean);
}

/**
 * Confirm only evidence attributable to this receipt. A host may expose the
 * submitted client ID, a provider message ID, or the accepted turn ID. Text,
 * timestamps, and unrelated later activity are deliberately not evidence.
 */
export function confirmedPaseoTurn(history, receipt) {
  const entries = history.entries ?? [];
  const ids = receiptIds(receipt);
  const turnId = nonEmpty(receipt?.turnId);
  const own = entries.find(e => e.item?.type === "user_message" && entryIds(e).some(id => ids.has(id)));
  const activeTurn = history.agent?.activeTurn;
  if (turnId && activeTurn?.turnId === turnId && history.agent?.status === "running") return true;
  if (!own) return false;
  if (turnId && own.turnId === turnId) return true;
  const started = Date.parse(history.agent?.activeTurn?.startedAt ?? "");
  return (history.agent?.status === "running" && Number.isFinite(started) && started >= Date.parse(own.timestamp))
    || entries.some(e => e.item?.type === "assistant_message" && e.seqStart > own.seqEnd);
}

async function readPaseoConfirmation(ref, receipt, signal) {
  const cursor = receipt?.cursor;
  const options = cursor
    ? { direction: "after", cursor, limit: 80 }
    : { direction: "tail", limit: 40 };
  try {
    return await ref.timeline.refetch(options);
  } catch (error) {
    // Older hosts may not support cursor reads. A tail fallback remains safe
    // because confirmation still requires the exact receipt identity.
    if (!cursor) throw error;
    signal?.throwIfAborted();
    return ref.timeline.refetch({ direction: "tail", limit: 40 });
  }
}

async function waitForPaseoTurn(ref, receipt, signal) {
  // The send acknowledgment can arrive before the message or provider turn
  // reaches the timeline. Recheck only this receipt; never repeat the send.
  // The surrounding Paseo request deadline also bounds every read and delay.
  const deadline = performance.now() + 5000;
  for (;;) {
    signal.throwIfAborted();
    const history = await readPaseoConfirmation(ref, receipt, signal);
    signal.throwIfAborted();
    if (confirmedPaseoTurn(history, receipt)) return true;
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    await delay(Math.min(250, remaining), undefined, { signal });
  }
}

// Never imports, reloads, archives or changes settings. Paseo owns the session.
// Refresh immediately before dispatch; steer is preferable to interrupt if a
// turn starts concurrently. Paseo may fall back to interruption when steering
// is unsupported: its public API does not offer an atomic idle-only send.
export async function deliverPaseo({ config, thread, text, store, actionId, base, factory }) {
  const blocked = detail => ({ status: "blocked", route: "paseo-send", actionId, detail });
  if (!config?.paseo?.enabled || thread?.kind !== "paseo" || thread.excluded) return blocked("Paseo delivery is not enabled for this chat");
  if (!store?.dir) return blocked("Paseo delivery needs durable storage");
  const digest = createHash("sha256").update(thread.key).digest("hex");
  const file = path.join(store.dir, "paseo-deliveries", `${digest}.json`);
  if (active.has(file)) return blocked("A send to this Paseo chat is already in progress");
  active.add(file);
  try {
    return await withPaseo(config, async (client, signal) => {
      const api = await hostApi(client, thread.meta.serverId);
      const ref = api.agents.ref(thread.id);
      let previous;
      try { previous = JSON.parse(fs.readFileSync(file, "utf8")); }
      catch (e) { if (e.code !== "ENOENT") return blocked("Paseo delivery journal cannot be read"); }
      if (previous?.pending) {
        const history = await readPaseoConfirmation(ref, previous, signal);
        signal.throwIfAborted();
        if (!confirmedPaseoTurn(history, previous)) return blocked("Previous delivery has no confirmed turn; no automatic resend");
        writeJsonAtomic(file, { ...previous, pending: false });
        // This receipt belongs to an older action, not the current proposal.
        return blocked("Previous Paseo turn confirmed; reassess the conversation before another send");
      }
      if (previous?.messageHash === base.messageHash && previous?.activityAt === thread.meta.updatedAt) return blocked("This nudge was already delivered for this chat revision");
      await ref.refresh();
      signal.throwIfAborted();
      const agent = ref.current();
      if (!agent || agent.archivedAt || agent.status !== "idle" || agent.activeTurn) return blocked("Paseo chat is active, closed, or unavailable");
      if (agent.pendingPermissions?.length) return blocked("Paseo chat requires owner permission");
      if (agent.cwd !== thread.meta.paseoCwd || agent.workspaceId !== thread.meta.workspaceId || agent.updatedAt !== thread.meta.updatedAt) return blocked("Paseo chat changed; scan again before sending");
      const baseline = await ref.timeline.refetch({ direction: "tail", limit: 1 });
      signal.throwIfAborted();
      const messageId = randomUUID();
      const cursor = timelineCursor(baseline);
      const intent = {
        messageId,
        clientMessageId: messageId,
        messageHash: base.messageHash,
        activityAt: agent.updatedAt,
        ...(cursor ? { cursor } : {}),
        pending: true,
      };
      writeJsonAtomic(file, intent); // Disk failure prevents dispatch.
      signal.throwIfAborted();
      const response = await ref.send(text, { messageId, activeTurnBehavior: "steer" });
      signal.throwIfAborted();
      const returnedClientMessageId = nonEmpty(response?.clientMessageId);
      if (returnedClientMessageId && returnedClientMessageId !== messageId) return blocked("Paseo returned a mismatched client message ID; no automatic resend");
      const correlated = {
        ...intent,
        ...(returnedClientMessageId ? { clientMessageId: returnedClientMessageId } : {}),
        ...(nonEmpty(response?.providerMessageId) ? { providerMessageId: response.providerMessageId } : {}),
        ...(nonEmpty(response?.messageId) && response.messageId !== messageId ? { providerMessageId: response.messageId } : {}),
        ...(nonEmpty(response?.turnId) ? { turnId: response.turnId } : {}),
      };
      writeJsonAtomic(file, correlated);
      if (!await waitForPaseoTurn(ref, correlated, signal)) return blocked("Message accepted; turn start unconfirmed. No automatic resend.");
      writeJsonAtomic(file, { ...correlated, pending: false });
      return { status: "sent", route: "paseo-send", actionId, detail: "Paseo message and turn confirmed" };
    }, factory);
  } catch { return blocked("Paseo delivery unavailable or uncertain; no provider fallback or automatic resend"); }
  finally { active.delete(file); }
}
