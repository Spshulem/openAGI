import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { writeJsonAtomic } from "../file-utils.js";
import { clampText, redactSecrets } from "./contracts.js";
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
  return epoch && seq !== null && seq >= 0 ? { epoch, seq } : null;
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

function receiptMessage(history, receipt) {
  const ids = receiptIds(receipt);
  return history.entries?.find(e => e.item?.type === "user_message" && entryIds(e).some(id => ids.has(id)));
}

/**
 * Confirm only evidence attributable to this receipt. A host may expose the
 * submitted client ID, a provider message ID, or the accepted turn ID. Text,
 * timestamps, and unrelated later activity are deliberately not evidence.
 */
export function confirmedPaseoTurn(history, receipt) {
  if (history.error || receipt.correlationMismatch) return false;
  const entries = history.entries ?? [];
  const ownTurn = nonEmpty(receiptMessage(history, receipt)?.turnId);
  const acceptedTurn = nonEmpty(receipt?.turnId);
  if (acceptedTurn && ownTurn && acceptedTurn !== ownTurn) return false;
  const turnId = acceptedTurn ?? ownTurn;
  if (!turnId) return false;
  const activeTurn = history.agent?.activeTurn;
  return (activeTurn?.turnId === turnId && history.agent?.status === "running")
    || entries.some(e => e.item?.type === "assistant_message" && e.turnId === turnId);
}

const ALLOWED_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);
const MAX_PASEO_IMAGES = 4;
const MAX_PASEO_IMAGE_BASE64_LEN = 7 * 1024 * 1024;

export function normalizePaseoImages(rawImages) {
  if (!Array.isArray(rawImages) || rawImages.length === 0) return [];
  const out = [];
  for (const item of rawImages) {
    if (out.length >= MAX_PASEO_IMAGES) break;
    if (!item || typeof item !== "object") continue;
    let data = typeof item.data === "string" ? item.data.trim() : "";
    let mimeType = typeof item.mimeType === "string" ? item.mimeType.trim().toLowerCase() : "";
    const dataUri = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(data);
    if (dataUri) {
      if (!mimeType) mimeType = dataUri[1].toLowerCase();
      data = dataUri[2].trim();
    }
    if (mimeType === "image/jpg") mimeType = "image/jpeg";
    if (!ALLOWED_IMAGE_MIMES.has(mimeType)) continue;
    const cleanBase64 = data.replace(/\s+/g, "");
    if (!cleanBase64 || cleanBase64.length > MAX_PASEO_IMAGE_BASE64_LEN) continue;
    if (!/^[A-Za-z0-9+/=_-]+$/.test(cleanBase64)) continue;
    out.push({ data: cleanBase64, mimeType });
  }
  return out;
}

function detectImmediatePaseoSystemError(history, receipt) {
  const entries = history?.entries ?? [];
  const ids = receiptIds(receipt);
  const ownIdx = entries.findIndex((e) => e?.item?.type === "user_message" && entryIds(e).some((id) => ids.has(id)));
  if (ownIdx < 0) return null;
  for (let idx = ownIdx + 1; idx < entries.length; idx += 1) {
    const entry = entries[idx];
    if (entry?.item?.type === "error") {
      return clampText(redactSecrets(String(entry.item.message ?? "Paseo runtime error")), 160);
    }
    if (entry?.item?.type === "assistant_message" && /^\[System Error\]/i.test(String(entry.item.text ?? "").trim())) {
      return clampText(redactSecrets(String(entry.item.text ?? "").replace(/^\[System Error\]\s*/i, "")), 160);
    }
  }
  return null;
}

function confirmedOwnerSteeredOrQueuedMessage(history, receipt) {
  if (history?.error || receipt?.correlationMismatch) return false;
  const entries = history?.entries ?? [];
  const ids = receiptIds(receipt);
  const ownIdx = entries.findIndex((e) => e?.item?.type === "user_message" && entryIds(e).some((id) => ids.has(id)));
  if (ownIdx < 0) return false;
  if (detectImmediatePaseoSystemError(history, receipt)) return false;
  const after = entries.slice(ownIdx + 1);
  if (after.some((e) => ["assistant_message", "tool_call"].includes(e?.item?.type))) return true;
  // When steering/messaging an actively running Paseo session, the host
  // frequently retains the prior activeTurn.turnId (or queues our message with
  // a different/pending turnId) until the in-flight step yields. Seeing our
  // exact clientMessageId/messageId in the running session's timeline proves
  // delivery without guessing from unrelated activity.
  return history?.agent?.status === "running";
}

async function recoverDisconnectedPaseoSession({ api, agent, thread, baselineEntries, text, images, serverId }) {
  const cwd = String(agent?.cwd ?? thread?.meta?.paseoCwd ?? "").trim();
  if (!cwd || typeof api?.providers?.waitForReady !== "function" || typeof api?.agents?.create !== "function") {
    return null;
  }
  const snap = await api.providers.waitForReady({ cwd, timeoutMs: 8000 });
  const entries = Array.isArray(snap?.entries) ? snap.entries : [];
  const ready = entries.find((e) => e?.status === "ready" && e?.provider === "codex")
    ?? entries.find((e) => e?.status === "ready" && e?.provider === "claude")
    ?? entries.find((e) => e?.status === "ready");
  const model = ready?.models?.find((m) => m?.isDefault) ?? ready?.models?.[0] ?? null;
  if (!ready?.provider || !model?.id) return null;

  const priorTail = (Array.isArray(baselineEntries) ? baselineEntries : [])
    .filter((e) => ["user_message", "assistant_message"].includes(e?.item?.type) && !/^\[System Error\]/i.test(String(e?.item?.text ?? "")))
    .slice(-4)
    .map((e) => `${e.item.type === "user_message" ? "Owner" : "Assistant"}: ${clampText(redactSecrets(String(e.item.text ?? "")), 400)}`)
    .join("\n");
  const cleanOriginal = String(text ?? "").replace(/^\[OpenAGI supervisor\]\s*(?:Owner says:\s*)?/i, "").trim();
  const baseTitle = clampText(redactSecrets(String(agent?.title ?? thread?.title ?? path.basename(cwd))), 72) || path.basename(cwd);
  const recoveryPrompt = priorTail
    ? `Continuing from Paseo session "${baseTitle}" (whose previous ${agent?.provider ?? "agent"} runtime disconnected).\n\nRecent context:\n${priorTail}\n\nNew owner request:\n${cleanOriginal || text}`
    : (cleanOriginal || text);

  const created = await api.agents.create({
    config: { provider: `${ready.provider}/${model.id}` },
    cwd,
    title: baseTitle,
    prompt: recoveryPrompt
  });
  if (!created?.id) return null;
  if (images?.length && typeof api?.agents?.ref === "function") {
    try {
      const newRef = api.agents.ref(created.id);
      await newRef.send("Attached image(s) from the owner for the request above.", {
        messageId: randomUUID(),
        activeTurnBehavior: "steer",
        images
      });
    } catch { /* prompt already delivered */ }
  }
  return {
    key: `paseo:${serverId}.${created.id}`,
    serverId,
    agentId: created.id,
    title: baseTitle,
    cwd
  };
}

async function readPaseoConfirmation(ref, receipt, signal, save, deadline = Infinity, { ownerInitiated = false } = {}) {
  if (receipt.correlationMismatch) return { confirmed: false, systemError: null };
  const cursor = receipt?.cursor;
  let options = cursor
    ? { direction: "after", cursor, limit: 80 }
    : { direction: "tail", limit: 40 };
  // Bound catch-up work as well as elapsed time. Never persist a read cursor:
  // projected entries can acquire correlation after their first appearance.
  for (let page = 0; page < 10; page++) {
    signal.throwIfAborted();
    if (performance.now() >= deadline) return { confirmed: false, systemError: null };
    let history;
    try {
      history = await ref.timeline.refetch(options);
      if (history.error) throw new Error("Paseo timeline unavailable");
      if (options.direction === "after" && (history.reset || history.staleCursor || history.gap
        || (history.epoch && history.epoch !== options.cursor.epoch))) {
        throw new Error("Paseo timeline cursor changed");
      }
    } catch (error) {
      // Cursor support and projection epochs vary by host. Fall back to a
      // fresh tail, which still needs exact identity; never infer from order.
      if (options.direction === "tail") throw error;
      signal.throwIfAborted();
      options = { direction: "tail", limit: 40 };
      continue;
    }
    signal.throwIfAborted();
    const sysErr = detectImmediatePaseoSystemError(history, receipt);
    if (sysErr) {
      return { confirmed: false, systemError: sysErr };
    }
    const own = receiptMessage(history, receipt);
    const sawOwn = Boolean(own);
    const ownTurn = nonEmpty(own?.turnId);
    if (ownTurn && receipt.turnId && ownTurn !== receipt.turnId) {
      receipt.correlationMismatch = true;
      save(receipt);
      return { confirmed: false, systemError: null, sawOwn };
    }
    const providerMessageId = nonEmpty(own?.item?.messageId);
    const learnedProvider = !receipt.providerMessageId && providerMessageId
      && providerMessageId !== receipt.messageId && receiptIds(receipt).has(own?.item?.clientMessageId);
    if ((ownTurn && !receipt.turnId) || learnedProvider) {
      if (ownTurn) receipt.turnId = ownTurn;
      if (learnedProvider) receipt.providerMessageId = providerMessageId;
      save(receipt); // Survives timeout, restart, and projection/history churn.
    }
    if (confirmedPaseoTurn(history, receipt)) return { confirmed: true, systemError: null, sawOwn: true };
    if (ownerInitiated && confirmedOwnerSteeredOrQueuedMessage(history, receipt)) {
      return { confirmed: true, systemError: null, sawOwn: true };
    }
    if (!history.hasNewer) return { confirmed: false, systemError: null, sawOwn };
    const next = timelineCursor(history);
    if (!next || (options.cursor && (next.epoch !== options.cursor.epoch || next.seq <= options.cursor.seq))) {
      return { confirmed: false, systemError: null, sawOwn };
    }
    options = { direction: "after", cursor: next, limit: 80 };
  }
  return { confirmed: false, systemError: null, sawOwn: false };
}

async function waitForPaseoTurn(ref, receipt, signal, save, { ownerInitiated = false, onSawOwn = null } = {}) {
  // The send acknowledgment can arrive before the message or provider turn
  // reaches the timeline. Recheck only this receipt; never repeat the send.
  // The surrounding Paseo request deadline also bounds every read and delay.
  const deadline = performance.now() + (ownerInitiated ? 15_000 : 5_000);
  let sawOwn = false;
  for (;;) {
    signal.throwIfAborted();
    const outcome = await readPaseoConfirmation(ref, receipt, signal, save, deadline, { ownerInitiated });
    signal.throwIfAborted();
    if (outcome.sawOwn) {
      sawOwn = true;
      onSawOwn?.();
    }
    if (outcome.confirmed || outcome.systemError) return { ...outcome, sawOwn };
    if (receipt.correlationMismatch) return { confirmed: false, systemError: null, sawOwn };
    const remaining = deadline - performance.now();
    if (remaining <= 0) return { confirmed: false, systemError: null, sawOwn };
    await delay(Math.min(250, remaining), undefined, { signal });
  }
}

const OWNER_PLAYBOOKS = new Set(["owner-message", "owner-answer"]);

function cleanOwnerPermissionReply(raw, ownerChoice = null) {
  if (typeof ownerChoice === "string" && ownerChoice.trim()) {
    return ownerChoice.trim();
  }
  const stripped = String(raw ?? "")
    .replace(/^\[OpenAGI supervisor\]\s*/i, "")
    .trim();
  const wrappedAnswer = /^Owner\s+answer:\s*([\s\S]*?)\.\s+Continue with that\.\s*$/i.exec(stripped);
  if (wrappedAnswer) return wrappedAnswer[1].trim();
  return stripped
    .replace(/^Owner(?:\s+(?:says|answered|answer|replied|reply|message))?:\s*/i, "")
    .trim();
}

function buildQuestionPermissionAnswers(perm, replyText, ownerChoice = null) {
  const clean = cleanOwnerPermissionReply(replyText, ownerChoice);
  const questions = Array.isArray(perm?.input?.questions) ? perm.input.questions : [];
  if (questions.length === 0) {
    return { answers: { "Question 1": clean } };
  }
  if (questions.length === 1) {
    const key = String(questions[0]?.header || "Question 1");
    return { answers: { [key]: clean } };
  }
  const rawLines = clean.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const numbered = rawLines
    .map((line) => /^(?:Q(?:uestion)?\s*)?(\d+)[.):-]\s*(.+)$/i.exec(line))
    .filter(Boolean);
  const byNumber = new Map(numbered.map((m) => [Number(m[1]), m[2].trim()]));
  const useLinePosition = byNumber.size === 0 && rawLines.length === questions.length;
  const answers = {};
  for (let idx = 0; idx < questions.length; idx += 1) {
    const q = questions[idx];
    const key = String(q?.header || `Question ${idx + 1}`);
    const specific = byNumber.get(idx + 1) ?? (useLinePosition ? rawLines[idx] : null);
    if (!specific) {
      return {
        error: `This prompt has ${questions.length} questions; reply with numbered answers (1: ..., 2: ...) so every question is answered`
      };
    }
    answers[key] = specific;
  }
  return { answers };
}

async function respondPaseoPermission(api, ref, agentId, requestId, response) {
  if (typeof api?.respondToPermissionAndWait === "function") {
    await api.respondToPermissionAndWait(agentId, requestId, response, 10000);
    return;
  }
  if (typeof api?.respondToPermission === "function") {
    await api.respondToPermission(agentId, requestId, response);
    return;
  }
  if (typeof ref?.respondToPermission === "function") {
    await ref.respondToPermission({ requestId, response });
    return;
  }
  throw new Error("Paseo client does not support respondToPermission");
}

function ineligibleAgent(agent, thread, { ownerInitiated = false, silentStuckRecovery = false } = {}) {
  if (!agent || agent.archivedAt) return "Paseo chat is active, closed, or unavailable";
  if (!ownerInitiated && agent.status === "closed") return "Paseo chat is active, closed, or unavailable";
  if (!ownerInitiated && !silentStuckRecovery && (agent.status !== "idle" || agent.activeTurn)) return "Paseo chat is active, closed, or unavailable";
  if (silentStuckRecovery && !["idle", "running", "initializing"].includes(agent.status)) return "Paseo chat is active, closed, or unavailable";
  if (ownerInitiated && !["idle", "running", "initializing", "error", "closed"].includes(agent.status)) return "Paseo chat is active, closed, or unavailable";
  if (agent.pendingPermissions?.length) return "Paseo chat requires owner permission";
  if ((thread.meta.paseoCwd != null && agent.cwd !== thread.meta.paseoCwd) || (thread.meta.workspaceId !== undefined && agent.workspaceId !== thread.meta.workspaceId)) return "Paseo chat changed; scan again before sending";
  if (!ownerInitiated && agent.updatedAt !== thread.meta.updatedAt) return "Paseo chat changed; scan again before sending";
  return null;
}

// Never imports, reloads, archives or changes settings. Paseo owns the session.
// Refresh immediately before dispatch; steer is preferable to interrupt if a
// turn starts concurrently. Paseo may fall back to interruption when steering
// is unsupported: its public API does not offer an atomic idle-only send.
export async function deliverPaseo({ config, thread, text, store, actionId, base, factory, ownerChoice = null, expectedPermissionId = null, images = null, recoverDisconnected = true }) {
  const blocked = detail => ({ status: "blocked", route: "paseo-send", actionId, detail });
  const ownerInitiated = OWNER_PLAYBOOKS.has(base?.playbook);
  const silentStuckRecovery = !ownerInitiated
    && Boolean(thread?.meta?.silentStuck)
    && ["status-check", "resume", "unblock-snag"].includes(base?.playbook);
  const normalizedImages = normalizePaseoImages(images);
  const blockedExclusion = ownerInitiated
    ? Boolean(thread?.archived || (thread?.excluded && !["closed", "history-unavailable"].includes(thread.excluded)))
    : Boolean(thread?.excluded);
  if (!config?.paseo?.enabled || thread?.kind !== "paseo" || blockedExclusion) return blocked("Paseo delivery is not enabled for this chat");
  if (!store?.dir) return blocked("Paseo delivery needs durable storage");
  const digest = createHash("sha256").update(thread.key).digest("hex");
  const file = path.join(store.dir, "paseo-deliveries", `${digest}.json`);
  const activeKey = file;
  if (active.has(activeKey)) return blocked("A send to this Paseo chat is already in progress");
  active.add(activeKey);
  let dispatched = false;
  let sawOwnBeforeAbort = false;
  try {
    return await withPaseo(config, async (client, signal) => {
      const api = await hostApi(client, thread.meta.serverId);
      const ref = api.agents.ref(thread.id);
      let previous;
      try { previous = JSON.parse(fs.readFileSync(file, "utf8")); }
      catch (e) { if (e.code !== "ENOENT") return blocked("Paseo delivery journal cannot be read"); }
      const save = receipt => writeJsonAtomic(file, receipt);
      if (previous?.pending) {
        const priorCheck = await readPaseoConfirmation(ref, previous, signal, save, Infinity, { ownerInitiated });
        signal.throwIfAborted();
        if (!priorCheck.confirmed) {
          if (!ownerInitiated) return blocked("Previous delivery has no confirmed turn; no automatic resend");
          // Owner explicitly initiated a new send; clear stale unconfirmed marker so older background nudges never brick manual coordination.
          writeJsonAtomic(file, { ...previous, pending: false });
        } else {
          writeJsonAtomic(file, { ...previous, pending: false });
          // This receipt belongs to an older action, not the current proposal.
          if (!ownerInitiated) return blocked("Previous Paseo turn confirmed; reassess the conversation before another send");
        }
      }
      if (!ownerInitiated && previous?.messageHash === base?.messageHash && previous?.activityAt === thread.meta.updatedAt) {
        return blocked("This nudge was already delivered for this chat revision");
      }
      await ref.refresh();
      signal.throwIfAborted();
      const agent = ref.current();
      const livePerms = Array.isArray(agent?.pendingPermissions) ? agent.pendingPermissions : [];
      const scannedPermId = expectedPermissionId
        ?? thread?.meta?.pendingPermission?.id
        ?? thread?.meta?.pendingCard?.requestId
        ?? null;
      if (ownerInitiated && expectedPermissionId && !livePerms.some((p) => p && String(p.id) === String(expectedPermissionId))) {
        return blocked("Paseo permission changed; scan again before sending");
      }
      if (ownerInitiated && agent && !agent.archivedAt && agent.status !== "closed" && livePerms.length > 0) {
        if ((thread.meta.paseoCwd != null && agent.cwd !== thread.meta.paseoCwd) || (thread.meta.workspaceId !== undefined && agent.workspaceId !== thread.meta.workspaceId)) {
          return blocked("Paseo chat changed; scan again before sending");
        }
        if (!scannedPermId) {
          return blocked("Paseo chat requires owner permission; scan again before sending");
        }
        const targetPerm = livePerms.find((p) => p && String(p.id) === String(scannedPermId));
        if (!targetPerm) {
          return blocked("Paseo permission changed; scan again before sending");
        }
        const cleanReply = cleanOwnerPermissionReply(text, ownerChoice);
        if (!cleanReply) return blocked("Empty permission response");
        if (targetPerm.kind === "question") {
          const parsedAnswers = buildQuestionPermissionAnswers(targetPerm, text, ownerChoice);
          if (parsedAnswers.error) return blocked(parsedAnswers.error);
          await respondPaseoPermission(api, ref, thread.id, String(targetPerm.id), {
            behavior: "allow",
            updatedInput: { answers: parsedAnswers.answers }
          });
          return { status: "sent", route: "paseo-send", actionId, detail: "Answered Paseo question directly" };
        }
        if (!/^(?:opened|open thread)$/i.test(cleanReply)) {
          const actions = Array.isArray(targetPerm.actions) ? targetPerm.actions : [];
          const replyLower = cleanReply.toLowerCase();
          const exactAction = actions.find((a) => {
            const full = redactSecrets(String(a?.label ?? "")).trim().toLowerCase();
            const clamped = clampText(redactSecrets(String(a?.label ?? "")), 40).trim().toLowerCase();
            return full === replyLower || clamped === replyLower;
          });
          const isAffirmative = exactAction
            ? exactAction.behavior === "allow"
            : /^(?:allow\b|approve\b|approved$|yes$|proceed$|go ahead$|ok$|okay$)/i.test(cleanReply);
          if (isAffirmative) {
            const allowAction = exactAction ?? actions.find((a) => a?.behavior === "allow");
            await respondPaseoPermission(api, ref, thread.id, String(targetPerm.id), {
              behavior: "allow",
              ...(allowAction?.id ? { selectedActionId: String(allowAction.id) } : {})
            });
            return { status: "sent", route: "paseo-send", actionId, detail: "Approved Paseo permission prompt" };
          }
          const denyAction = exactAction ?? actions.find((a) => a?.behavior === "deny");
          await respondPaseoPermission(api, ref, thread.id, String(targetPerm.id), {
            behavior: "deny",
            ...(denyAction?.id ? { selectedActionId: String(denyAction.id) } : {}),
            message: cleanReply
          });
          return { status: "sent", route: "paseo-send", actionId, detail: "Sent response to Paseo permission prompt" };
        }
      }
      const preflight = ineligibleAgent(agent, thread, { ownerInitiated, silentStuckRecovery });
      if (preflight) return blocked(preflight);
      const baseline = await ref.timeline.refetch({ direction: "tail", limit: ownerInitiated ? 8 : 1 });
      signal.throwIfAborted();
      if (baseline.error) return blocked("Paseo timeline unavailable; scan again before sending");
      // refetch updates the SDK handle; check both snapshots so a newer event
      // or an unavailable baseline cannot be hidden by the other snapshot.
      const changed = ineligibleAgent(baseline.agent, thread, { ownerInitiated, silentStuckRecovery }) || ineligibleAgent(ref.current(), thread, { ownerInitiated, silentStuckRecovery });
      if (changed) return blocked(changed);
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
      const sendOptions = {
        messageId,
        activeTurnBehavior: "steer",
        ...(normalizedImages.length ? { images: normalizedImages } : {})
      };
      let response;
      dispatched = true;
      try {
        response = await ref.send(text, sendOptions);
      } catch (sendErr) {
        if (ownerInitiated) {
          writeJsonAtomic(file, { ...intent, pending: false });
          const errReason = clampText(redactSecrets(String(sendErr?.message ?? "runtime disconnected")), 120);
          if (!recoverDisconnected) return blocked(`Paseo delivery failed: ${errReason}; existing session only`);
          const recovered = await recoverDisconnectedPaseoSession({
            api,
            agent,
            thread,
            baselineEntries: baseline.entries,
            text,
            images: normalizedImages,
            serverId: thread.meta.serverId
          }).catch(() => null);
          if (recovered) {
            return {
              status: "sent",
              route: "paseo-send",
              actionId,
              ...(normalizedImages.length ? { attachedImages: normalizedImages.length } : {}),
              recoveredSession: recovered,
              detail: `Session runtime disconnected (${errReason}); started fresh Paseo session in ${path.basename(recovered.cwd)} (${recovered.key}) and delivered message`
            };
          }
          return blocked(`Paseo delivery failed: ${errReason}`);
        }
        throw sendErr;
      }
      signal.throwIfAborted();
      // The pinned SDK returns void. Timeline correlation is required there;
      // retain optional response IDs only if a future adapter exposes them.
      const returnedClientMessageId = nonEmpty(response?.clientMessageId);
      if (returnedClientMessageId && returnedClientMessageId !== messageId) {
        save({ ...intent, correlationMismatch: true });
        return blocked("Paseo returned a mismatched client message ID; no automatic resend");
      }
      const correlated = {
        ...intent,
        ...(returnedClientMessageId ? { clientMessageId: returnedClientMessageId } : {}),
        ...(nonEmpty(response?.providerMessageId) ? { providerMessageId: response.providerMessageId } : {}),
        ...(nonEmpty(response?.messageId) && response.messageId !== messageId ? { providerMessageId: response.messageId } : {}),
        ...(nonEmpty(response?.turnId) ? { turnId: response.turnId } : {}),
      };
      writeJsonAtomic(file, correlated);
      const turnOutcome = await waitForPaseoTurn(ref, correlated, signal, save, {
        ownerInitiated: ownerInitiated || silentStuckRecovery,
        onSawOwn: () => { sawOwnBeforeAbort = true; }
      });
      if (turnOutcome.systemError) {
        writeJsonAtomic(file, { ...correlated, pending: false });
        if (ownerInitiated && recoverDisconnected) {
          const recovered = await recoverDisconnectedPaseoSession({
            api,
            agent,
            thread,
            baselineEntries: baseline.entries,
            text,
            images: normalizedImages,
            serverId: thread.meta.serverId
          }).catch(() => null);
          if (recovered) {
            return {
              status: "sent",
              route: "paseo-send",
              actionId,
              ...(normalizedImages.length ? { attachedImages: normalizedImages.length } : {}),
              recoveredSession: recovered,
              detail: `Session runtime disconnected (${turnOutcome.systemError}); started fresh Paseo session in ${path.basename(recovered.cwd)} (${recovered.key}) and delivered message`
            };
          }
        }
        return blocked(`Paseo session runtime error: ${turnOutcome.systemError}${recoverDisconnected ? "" : "; existing session only"}`);
      }
      if (!turnOutcome.confirmed) {
        if (ownerInitiated) {
          return {
            status: "blocked",
            unconfirmed: true,
            route: "paseo-send",
            actionId,
            detail: turnOutcome.sawOwn
              ? "Message accepted by Paseo and visible in timeline; agent turn has not started yet. No automatic resend."
              : "Message accepted by Paseo; turn start unconfirmed. No automatic resend."
          };
        }
        return blocked("Message accepted; turn start unconfirmed. No automatic resend.");
      }
      writeJsonAtomic(file, { ...correlated, pending: false });
      return {
        status: "sent",
        route: "paseo-send",
        actionId,
        ...(normalizedImages.length ? { attachedImages: normalizedImages.length } : {}),
        detail: normalizedImages.length ? `Paseo message, ${normalizedImages.length} image(s), and turn confirmed` : "Paseo message and turn confirmed"
      };
    }, factory);
  } catch (err) {
    const errMsg = ownerInitiated && err?.message ? `: ${clampText(redactSecrets(String(err.message)), 120)}` : "";
    if (ownerInitiated && dispatched) {
      return {
        status: "blocked",
        unconfirmed: true,
        route: "paseo-send",
        actionId,
        detail: sawOwnBeforeAbort
          ? `Message accepted by Paseo and visible in timeline; turn confirmation timed out${errMsg}. No automatic resend.`
          : `Paseo delivery unavailable or uncertain${errMsg}; no provider fallback or automatic resend`
      };
    }
    return blocked(`Paseo delivery unavailable or uncertain${errMsg}; no provider fallback or automatic resend`);
  }
  finally { active.delete(activeKey); }
}
