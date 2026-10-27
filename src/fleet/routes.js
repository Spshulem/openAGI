// JSON API behind the /fleet mini app. Called only after the hosted
// interface's shared authentication/Origin gate. Never touches res: returns
// { status, body }, or null for paths it does not own.

import { MODES, THREAD_KEY_PATTERN } from "./contracts.js";
import { FIX_AREAS } from "./feedback.js";
import { DEADLINE_MARGIN_MS } from "./ui-delivery.js";

const PREFIX = "/fleet/api/";
const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const ANSWER_MAX = 200;
const SEND_MAX = 2000;
const LABEL_MAX = 80;
const THREAD_KEY = THREAD_KEY_PATTERN;
const APPS = new Set(["conductor", "codex"]);
const APP_ACTIONS = new Set(["open", "quit", "restart"]);
const THREAD_ACTIONS = new Set(["push", "mute", "unmute"]);
const MUTE_HOURS_MAX = 7 * 24;

// A thread key from the path: "conductor:<id>", its colon raw or %3A.
function pathThreadKey(segment) {
  let key;
  try { key = decodeURIComponent(segment); } catch { return null; }
  return THREAD_KEY.test(key) ? key : null;
}

const ok = (body) => ({ status: 200, body });
const fail = (status, error, extra = {}) => ({ status, body: { error, ...extra } });

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readObject(readBody) {
  try {
    const body = await readBody();
    return isPlainObject(body) ? body : null;
  } catch {
    return null;
  }
}

export function createFleetRoute({ supervisor } = {}) {
  const state = () => supervisor.getState();

  async function handleQuestion(id, readBody, sendOptions) {
    const body = await readObject(readBody);
    if (!body) return fail(400, "Send a JSON object: { answer }, { dismiss: true } or { reopen: true }.");
    // Brings back a question the supervisor's review closed.
    if (body.reopen === true) {
      if (typeof supervisor.reopenReviewed !== "function") return fail(503, "Reopening is not available.");
      const question = await supervisor.reopenReviewed(id);
      if (!question) return fail(409, "Only a question the review closed can be reopened.");
      return ok({ question, state: state() });
    }
    const open = (state().questions ?? []).find((q) => q?.id === id);
    if (body.dismiss === true) {
      if (!open) return fail(404, "No open question with that id.");
      const question = await supervisor.dismissQuestion(id);
      if (!question) return fail(409, "Question already closed.");
      return ok({ question, state: state() });
    }
    const answer = typeof body.answer === "string" ? body.answer.trim() : "";
    if (!answer || answer.length > ANSWER_MAX) return fail(400, "Pick one of the question's options.");
    if (!open) return fail(404, "No open question with that id.");
    const options = Array.isArray(open.options) ? open.options : [];
    if (answer !== "dismiss" && !options.includes(answer)) return fail(400, "Pick one of the question's options.");
    if (answer === "Answer question" && (typeof body.clarification !== "string" || !body.clarification.trim() || body.clarification.length > 2000)) {
      return fail(400, "Provide a clarification of 1 to 2000 characters.");
    }
    if (open.kind === "self-fix" && answer === "Request changes" && typeof body.instructions === "string") {
      const fix = await supervisor.reviseFix(open.meta?.fixId, body.instructions);
      return fix ? ok({ question: (state().questions ?? []).find((q) => q.id === id) ?? null, fix, delivery: { status: "sent", detail: "Changes sent to fixer." }, state: state() }) : fail(404, "No fix with that id.");
    }
    const result = await supervisor.answerQuestion(id, answer, { ...sendOptions, ...(answer === "Answer question" ? { clarification: body.clarification } : {}) });
    if (!result) return fail(409, "Question already closed.");
    return ok({ question: result.question ?? null, delivery: result.delivery ?? null,
      ...(result.nonResolving ? { nonResolving: true, plan: result.plan } : {}), state: state() });
  }

  async function handleSend(id, sendOptions) {
    const result = await supervisor.sendProposed(id, sendOptions);
    if (result) return ok({ action: result.action ?? null, delivery: result.delivery ?? null, state: state() });
    const known = (state().actions ?? []).some((a) => a?.id === id);
    return known ? fail(409, "Only a proposed action can be sent.") : fail(404, "No action with that id.");
  }

  // deadlineAt: when a remote caller stops waiting (ms, this clock); app
  // sends end before it. remote: the request came through the node broker.
  return async function fleetRoute(method, pathname, url, readBody, { deadlineAt = null, remote = false } = {}) {
    const sendOptions = { deadlineAt };
    if (!pathname.startsWith(PREFIX)) return null;
    if (!supervisor) return fail(503, "Fleet supervisor is not available.");
    const parts = pathname.slice(PREFIX.length).split("/");
    try {
      if (parts.length === 1 && parts[0] === "diagnose") {
        if (method !== "GET") return fail(405, "Use GET.");
        if (typeof supervisor.diagnose !== "function") return fail(503, "Diagnose is not available.");
        const window = url?.searchParams?.get("window") ?? "24h";
        const area = url?.searchParams?.get("area") ?? null;
        if (!["24h", "7d"].includes(window) || (area && !FIX_AREAS.includes(area))) return fail(400, "Bad diagnose window or area.");
        return ok(await supervisor.diagnose({ window, area }));
      }
      if (parts[0] === "suggestions" && (parts.length === 1 || parts.length === 2)) {
        if (typeof supervisor.suggestions !== "function") return fail(503, "Suggestions are not available.");
        if (parts.length === 1) return method === "GET" ? ok({ suggestions: await supervisor.suggestions() }) : fail(405, "Use GET.");
        if (!ID_PATTERN.test(parts[1])) return fail(400, "Bad suggestion id.");
        if (method === "GET") {
          const suggestion = (await supervisor.suggestions()).find((s) => s.id === parts[1]);
          return suggestion ? ok({ suggestion }) : fail(404, "No suggestion with that id.");
        }
        if (method !== "POST") return fail(405, "Use POST.");
        const body = await readObject(readBody);
        try {
          const result = await supervisor.respondSuggestion(parts[1], body?.choice, {
            ...(typeof body?.fixId === "string" ? { fixId: body.fixId } : {}), clarification: body?.clarification });
          return result ? ok(result) : fail(404, "No suggestion with that id.");
        } catch { return fail(409, "Suggestion could not be applied. Check its choice, self-fix mode, locks and daily cap."); }
      }
      if (parts.length === 1 && parts[0] === "state") {
        if (method !== "GET") return fail(405, "Use GET.");
        await supervisor.refresh?.();
        return ok(state());
      }
      if (parts.length === 1 && parts[0] === "scan") {
        if (method !== "POST") return fail(405, "Use POST.");
        try {
          // The owner's Scan now: rechecks every open question too. One
          // through the broker types nothing: the broker would stop waiting
          // mid-send, and a retried scan would nudge again.
          const scan = supervisor.tick({ reason: "owner-scan", ...(remote ? { deferUi: true } : {}) });
          // It can ride a follow-up a local scan shares, which may type: a
          // broker caller gets its answer before its deadline, the scan still
          // running if it must.
          if (remote && Number.isFinite(deadlineAt)) {
            let timer;
            const cutoff = new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, deadlineAt - DEADLINE_MARGIN_MS - Date.now()), false); });
            const done = await Promise.race([Promise.resolve(scan).then(() => true), cutoff]).finally(() => clearTimeout(timer));
            if (!done) Promise.resolve(scan).catch(() => {});
          } else await scan;
        } catch {
          return fail(500, "Scan failed.", { state: state() });
        }
        return ok(state());
      }
      if (parts.length === 1 && parts[0] === "mode") {
        if (method !== "POST") return fail(405, "Use POST.");
        const body = await readObject(readBody);
        const mode = typeof body?.mode === "string" ? body.mode : "";
        if (!MODES.includes(mode) || await supervisor.setMode(mode) === null) {
          return fail(400, "Mode must be one of: " + MODES.join(", ") + ".");
        }
        return ok(state());
      }
      if (parts.length === 2 && parts[0] === "questions") {
        if (method !== "POST") return fail(405, "Use POST.");
        if (!ID_PATTERN.test(parts[1])) return fail(400, "Bad question id.");
        return await handleQuestion(parts[1], readBody, sendOptions);
      }
      if (parts.length === 1 && parts[0] === "send") {
        if (method !== "POST") return fail(405, "Use POST.");
        const body = await readObject(readBody);
        const threadKey = typeof body?.threadKey === "string" ? body.threadKey.trim() : "";
        const message = typeof body?.message === "string" ? body.message.trim() : "";
        if (!THREAD_KEY.test(threadKey)) return fail(400, "Pass a thread key from the fleet state.");
        if (!message || message.length > SEND_MAX) return fail(400, `Message must be 1-${SEND_MAX} characters.`);
        if (typeof supervisor.sendOwnerMessage !== "function") return fail(503, "Sending is not available.");
        const result = await supervisor.sendOwnerMessage(threadKey, message, body?.queue === true ? { ...sendOptions, queue: true } : sendOptions);
        return ok({ delivery: result?.delivery ?? null, state: state() });
      }
      // One thread's screen: its permission card, whether a turn runs, the
      // transcript's tail. No input.
      if (parts.length === 1 && parts[0] === "screen") {
        if (method !== "POST") return fail(405, "Use POST.");
        const body = await readObject(readBody);
        const threadKey = typeof body?.threadKey === "string" ? body.threadKey.trim() : "";
        if (!THREAD_KEY.test(threadKey)) return fail(400, "Pass a thread key from the fleet state.");
        if (typeof supervisor.screenThread !== "function") return fail(503, "Screen reads are not available.");
        const screen = await supervisor.screenThread(threadKey, sendOptions);
        return ok({ ...screen, state: state() });
      }
      // One button of a thread's permission card (or its Resume button), by
      // exact label; stateId pins the card the caller read.
      if (parts.length === 1 && parts[0] === "click") {
        if (method !== "POST") return fail(405, "Use POST.");
        const body = await readObject(readBody);
        const threadKey = typeof body?.threadKey === "string" ? body.threadKey.trim() : "";
        const label = typeof body?.label === "string" ? body.label.trim() : "";
        const stateId = body?.stateId === undefined || body?.stateId === null ? null : String(body.stateId);
        if (!THREAD_KEY.test(threadKey)) return fail(400, "Pass a thread key from the fleet state.");
        if (!label || label.length > LABEL_MAX) return fail(400, `Label must be 1-${LABEL_MAX} characters.`);
        if (stateId !== null && !/^[0-9a-f]{16}$/.test(stateId)) return fail(400, "Bad stateId.");
        if (typeof supervisor.clickThread !== "function") return fail(503, "Clicking is not available.");
        const result = await supervisor.clickThread(threadKey, label, { ...sendOptions, stateId });
        return ok({ delivery: result?.delivery ?? null, prompt: result?.prompt ?? null, state: state() });
      }
      // The chats a quit or restart would stop right now, read live.
      if (parts.length === 3 && parts[0] === "apps" && parts[2] === "running") {
        if (method !== "GET") return fail(405, "Use GET.");
        if (!APPS.has(parts[1])) return fail(404, "Unknown fleet route.");
        if (typeof supervisor.runningInApp !== "function") return fail(503, "App control is not available.");
        const running = await supervisor.runningInApp(parts[1]);
        if (!running) return fail(503, "Could not read which chats are running.");
        return ok({ running, state: state() });
      }
      // Open, quit or restart Conductor or the Codex app. expectRunning: the
      // chats the caller approved stopping.
      if (parts.length === 3 && parts[0] === "apps") {
        if (method !== "POST") return fail(405, "Use POST.");
        if (!APPS.has(parts[1]) || !APP_ACTIONS.has(parts[2])) return fail(404, "Unknown fleet route.");
        const body = (await readObject(readBody)) ?? {};
        const expectRunning = Array.isArray(body.expectRunning) ? body.expectRunning.filter((key) => typeof key === "string" && THREAD_KEY.test(key)).slice(0, 50) : [];
        if (typeof supervisor.appAction !== "function") return fail(503, "App control is not available.");
        const result = await supervisor.appAction(parts[1], parts[2], { ...sendOptions, expectRunning });
        return ok({ result, state: state() });
      }
      // The owner's feedback (voice or typed): GET lists it, POST records one.
      if (parts.length === 1 && parts[0] === "feedback") {
        if (typeof supervisor.recordFeedback !== "function") return fail(503, "Feedback is not available.");
        if (method === "GET") return ok({ feedback: await supervisor.feedback({ limit: 100 }) });
        if (method !== "POST") return fail(405, "Use GET or POST.");
        const body = await readObject(readBody);
        if (!body) return fail(400, "Send a JSON object: { utterance, intent, target?, source? }.");
        try {
          return ok({ feedback: await supervisor.recordFeedback(body) });
        } catch (error) {
          return fail(400, String(error?.message ?? "Bad feedback.").slice(0, 200));
        }
      }
      // Self-fix runs: GET lists them,
      // POST queues one; stop and revise act on one ("all" stops every one).
      if (parts[0] === "fixes" && (parts.length === 1 || (parts.length === 3 && ["stop", "revise"].includes(parts[2])))) {
        if (typeof supervisor.queueFix !== "function") return fail(503, "Self-fix is not available.");
        if (parts.length === 1 && method === "GET") return ok({ fixes: await supervisor.fixes() });
        if (method !== "POST") return fail(405, "Use POST.");
        const body = (await readObject(readBody)) ?? {};
        try {
          if (parts.length === 1) return ok({ fix: await supervisor.queueFix(body) });
          if (!ID_PATTERN.test(parts[1])) return fail(400, "Bad fix id.");
          if (parts[2] === "stop") return ok({ stopped: await supervisor.stopFix(parts[1]) });
          const fix = await supervisor.reviseFix(parts[1], body.instructions);
          return fix ? ok({ fix }) : fail(404, "No fix with that id.");
        } catch (error) {
          return fail(400, String(error?.message ?? "Bad fix request.").slice(0, 200));
        }
      }
      // One thread, expanded: its detail (GET), or the owner's Push now,
      // Mute or Unmute of it (POST).
      if (parts[0] === "threads" && (parts.length === 2 || parts.length === 3)) {
        const threadKey = pathThreadKey(parts[1]);
        if (!threadKey) return fail(400, "Pass a thread key from the fleet state.");
        if (parts.length === 2) {
          if (method !== "GET") return fail(405, "Use GET.");
          if (typeof supervisor.threadDetail !== "function") return fail(503, "Thread details are not available.");
          const thread = await supervisor.threadDetail(threadKey);
          if (!thread) return fail(404, "No thread with that key in the last scan.");
          const conversation = await supervisor.threadConversation?.(threadKey);
          return ok({ thread: conversation ? { ...thread, conversation } : thread });
        }
        if (!THREAD_ACTIONS.has(parts[2])) return fail(404, "Unknown fleet route.");
        if (method !== "POST") return fail(405, "Use POST.");
        if (parts[2] === "push") {
          if (typeof supervisor.pushNow !== "function") return fail(503, "Push now is not available.");
          const result = await supervisor.pushNow(threadKey, sendOptions);
          return ok({ delivery: result?.delivery ?? null, action: result?.action ?? null, state: state() });
        }
        if (typeof supervisor.muteThread !== "function") return fail(503, "Muting is not available.");
        if (parts[2] === "unmute") return ok({ muted: (await supervisor.unmuteThread(threadKey))?.until ?? null, state: state() });
        const body = (await readObject(readBody)) ?? {};
        const hours = body.hours === undefined ? undefined : Number(body.hours);
        if (hours !== undefined && !(Number.isInteger(hours) && hours >= 1 && hours <= MUTE_HOURS_MAX)) return fail(400, `hours must be a whole number from 1 to ${MUTE_HOURS_MAX}.`);
        const muted = await supervisor.muteThread(threadKey, hours === undefined ? {} : { hours });
        return ok({ muted: muted?.until ?? null, state: state() });
      }
      if (parts.length === 3 && parts[0] === "actions" && parts[2] === "send") {
        if (method !== "POST") return fail(405, "Use POST.");
        if (!ID_PATTERN.test(parts[1])) return fail(400, "Bad action id.");
        return await handleSend(parts[1], sendOptions);
      }
    } catch {
      // Supervisor internals can carry paths or transcript text; keep them out.
      return fail(500, "Fleet supervisor error. Check the daemon log.");
    }
    return fail(404, "Unknown fleet route.");
  };
}
