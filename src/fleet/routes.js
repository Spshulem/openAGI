// JSON API behind the /fleet mini app. Called only after the hosted
// interface's shared authentication/Origin gate. Never touches res: returns
// { status, body }, or null for paths it does not own.

import { MODES } from "./contracts.js";

const PREFIX = "/fleet/api/";
const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const ANSWER_MAX = 200;

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

  async function handleQuestion(id, readBody) {
    const body = await readObject(readBody);
    if (!body) return fail(400, "Send a JSON object: { answer } or { dismiss: true }.");
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
    const result = await supervisor.answerQuestion(id, answer);
    if (!result) return fail(409, "Question already closed.");
    return ok({ question: result.question ?? null, delivery: result.delivery ?? null, state: state() });
  }

  async function handleSend(id) {
    const result = await supervisor.sendProposed(id);
    if (result) return ok({ action: result.action ?? null, delivery: result.delivery ?? null, state: state() });
    const known = (state().actions ?? []).some((a) => a?.id === id);
    return known ? fail(409, "Only a proposed action can be sent.") : fail(404, "No action with that id.");
  }

  return async function fleetRoute(method, pathname, url, readBody) {
    if (!pathname.startsWith(PREFIX)) return null;
    if (!supervisor) return fail(503, "Fleet supervisor is not available.");
    const parts = pathname.slice(PREFIX.length).split("/");
    try {
      if (parts.length === 1 && parts[0] === "state") {
        return method === "GET" ? ok(state()) : fail(405, "Use GET.");
      }
      if (parts.length === 1 && parts[0] === "scan") {
        if (method !== "POST") return fail(405, "Use POST.");
        try {
          await supervisor.tick({ reason: "manual" });
        } catch {
          return fail(500, "Scan failed.", { state: state() });
        }
        return ok(state());
      }
      if (parts.length === 1 && parts[0] === "mode") {
        if (method !== "POST") return fail(405, "Use POST.");
        const body = await readObject(readBody);
        const mode = typeof body?.mode === "string" ? body.mode : "";
        if (!MODES.includes(mode) || supervisor.setMode(mode) === null) {
          return fail(400, "Mode must be one of: " + MODES.join(", ") + ".");
        }
        return ok(state());
      }
      if (parts.length === 2 && parts[0] === "questions") {
        if (method !== "POST") return fail(405, "Use POST.");
        if (!ID_PATTERN.test(parts[1])) return fail(400, "Bad question id.");
        return await handleQuestion(parts[1], readBody);
      }
      if (parts.length === 3 && parts[0] === "actions" && parts[2] === "send") {
        if (method !== "POST") return fail(405, "Use POST.");
        if (!ID_PATTERN.test(parts[1])) return fail(400, "Bad action id.");
        return await handleSend(parts[1]);
      }
    } catch {
      // Supervisor internals can carry paths or transcript text; keep them out.
      return fail(500, "Fleet supervisor error. Check the daemon log.");
    }
    return fail(404, "Unknown fleet route.");
  };
}
