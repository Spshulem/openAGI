import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { writeJsonAtomic } from "../file-utils.js";
import { withPaseo, hostApi } from "./sources/paseo.js";

const active = new Set();
export function confirmedPaseoTurn(history, messageId) {
  const entries = history.entries ?? [];
  const own = entries.find(e => e.item?.type === "user_message" && [e.item.messageId, e.item.clientMessageId].includes(messageId));
  if (!own) return false;
  const started = Date.parse(history.agent?.activeTurn?.startedAt ?? "");
  return (history.agent?.status === "running" && Number.isFinite(started) && started >= Date.parse(own.timestamp))
    || entries.some(e => e.item?.type === "assistant_message" && e.seqStart > own.seqEnd);
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
        const history = await ref.timeline.refetch({ direction: "tail", limit: 40 });
        signal.throwIfAborted();
        if (!confirmedPaseoTurn(history, previous.messageId)) return blocked("Previous delivery has no confirmed turn; no automatic resend");
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
      const intent = { messageId: randomUUID(), messageHash: base.messageHash, activityAt: agent.updatedAt, pending: true };
      writeJsonAtomic(file, intent); // Disk failure prevents dispatch.
      signal.throwIfAborted();
      await ref.send(text, { messageId: intent.messageId, activeTurnBehavior: "steer" });
      signal.throwIfAborted();
      const history = await ref.timeline.refetch({ direction: "tail", limit: 40 });
      signal.throwIfAborted();
      if (!confirmedPaseoTurn(history, intent.messageId)) return blocked("Message accepted; turn start unconfirmed. No automatic resend.");
      writeJsonAtomic(file, { ...intent, pending: false });
      return { status: "sent", route: "paseo-send", actionId, detail: "Paseo message and turn confirmed" };
    }, factory);
  } catch { return blocked("Paseo delivery unavailable or uncertain; no provider fallback or automatic resend"); }
  finally { active.delete(file); }
}
