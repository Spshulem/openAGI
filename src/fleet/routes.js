// JSON API behind the /fleet mini app. Called only after the hosted
// interface's shared authentication/Origin gate. Never touches res: returns
// { status, body }, or null for paths it does not own.

import { MODES, THREAD_KEY_PATTERN } from "./contracts.js";
import { FIX_AREAS } from "./feedback.js";
import { DEADLINE_MARGIN_MS } from "./ui-delivery.js";
import { SupervisorWalkthrough, WalkthroughError } from "./walkthrough.js";

const PREFIX = "/fleet/api/";
const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const CARD_ID_PATTERN = /^[A-Za-z0-9:_-]{1,120}$/;
const ANSWER_MAX = 200;

function pathCardId(segment) {
  let id;
  try { id = decodeURIComponent(segment); } catch { return null; }
  return CARD_ID_PATTERN.test(id) ? id : null;
}
const SEND_MAX = 2000;
const REPLY_MAX = 2000;
const LABEL_MAX = 80;
const THREAD_KEY = THREAD_KEY_PATTERN;
const APPS = new Set(["conductor", "codex"]);
const APP_ACTIONS = new Set(["open", "quit", "restart"]);
const THREAD_ACTIONS = new Set(["push", "mute", "unmute", "archive", "unarchive", "failover"]);
const BATCH_OPS = new Set([
  "merge_green", "defer", "dismiss", "fix_ci", "primary", "secondary", "merge", "answer", "reply"
]);
const BATCH_FILTERS = new Set(["green_prs", "ci_failed", "questions", "non_pr", "all"]);
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

function safeActiveWorkError(err, fallback) {
  if (err?.code || err?.syscall || err?.path) {
    return fail(503, "Active Work storage error. Check available disk space and daemon log.");
  }
  return fail(400, String(err?.message ?? fallback).slice(0, 220));
}

async function readObject(readBody) {
  try {
    const body = await readBody();
    return isPlainObject(body) ? body : null;
  } catch {
    return null;
  }
}

export function createFleetRoute({ supervisor, dataDir } = {}) {
  const walkthrough = supervisor ? new SupervisorWalkthrough({ dataDir: dataDir ?? supervisor.dataDir }) : null;
  const state = () => supervisor.getState();

  async function handleQuestion(id, readBody, sendOptions) {
    const body = await readObject(readBody);
    if (!body) return fail(400, "Send a JSON object: { answer }, { reply }, { dismiss: true } or { reopen: true }.");
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
    // The owner's own words to the agent that asked (questions whose
    // canReply is true): sent or kept closes it, blocked leaves it open.
    if (body.reply !== undefined) {
      const reply = typeof body.reply === "string" ? body.reply.trim() : "";
      if (!reply || reply.length > REPLY_MAX) return fail(400, `Reply must be 1-${REPLY_MAX} characters.`);
      if (!open) return fail(404, "No open question with that id.");
      if (open.canReply !== true) {
        if (open.kind === "suggestion" && Array.isArray(open.options) && open.options.includes("Answer question")) {
          if (typeof supervisor.answerQuestion !== "function") return fail(503, "Questions are not available.");
          const result = await supervisor.answerQuestion(id, "Answer question", {
            ...sendOptions,
            clarification: reply.slice(0, 2000)
          });
          if (!result) return fail(409, "Question already closed.");
          return ok({
            question: result.question ?? null,
            delivery: result.delivery ?? null,
            ...(result.nonResolving ? { nonResolving: true, plan: result.plan } : {}),
            state: state()
          });
        }
        return fail(409, "This question takes no typed reply. Pick an option, or answer it in its chat.");
      }
      if (typeof supervisor.replyQuestion !== "function") return fail(503, "Replies are not available.");
      const result = await supervisor.replyQuestion(id, reply, sendOptions);
      if (!result) return fail(409, "Question already closed.");
      return ok({ question: result.question ?? null, delivery: result.delivery ?? null, state: state() });
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
      if (parts.length === 1 && parts[0] === "walkthrough") {
        if (!walkthrough) return fail(503, "Supervisor walkthrough is not available.");
        if (method === "GET") return ok(walkthrough.read(state()));
        if (method !== "POST") return fail(405, "Use GET or POST.");
        const body = (await readObject(readBody)) ?? {};
        const operation = typeof body.operation === "string" ? body.operation : body.op;
        const expectedId = body.expectedId;
        try { return ok(walkthrough.mutate(operation, expectedId, state())); }
        catch (error) {
          if (error instanceof WalkthroughError) return fail(error.status, error.message);
          throw error;
        }
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
      if (parts.length === 1 && parts[0] === "search") {
        if (method !== "GET") return fail(405, "Use GET.");
        const query = url?.searchParams?.get("query") ?? url?.searchParams?.get("q") ?? "";
        const limit = Number(url?.searchParams?.get("limit") ?? 20);
        if (!query.trim() || query.length > 300 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
          return fail(400, "Pass a query of 1-300 characters and a limit of 1-50.");
        }
        if (typeof supervisor.searchThreads !== "function") {
          return fail(503, "Update OpenAGI on the fleet computer to search conversations.");
        }
        return ok(await supervisor.searchThreads({ query, limit }));
      }
      if (parts.length === 1 && parts[0] === "workspaces") {
        if (method !== "GET") return fail(405, "Use GET.");
        if (typeof supervisor.listWorkspaces !== "function") {
          return fail(503, "Workspace inventory is not available.");
        }
        const query = url?.searchParams?.get("query") ?? url?.searchParams?.get("q") ?? "";
        const includeArchived = url?.searchParams?.get("includeArchived") === "true";
        const limit = Number(url?.searchParams?.get("limit") ?? 30);
        if (query.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 60) {
          return fail(400, "Pass a query up to 200 characters and a limit of 1-60.");
        }
        return ok(await supervisor.listWorkspaces({ query, includeArchived, limit }));
      }
      if (parts.length === 1 && parts[0] === "hierarchy") {
        if (method !== "GET") return fail(405, "Use GET.");
        if (typeof supervisor.getHierarchy !== "function") {
          return fail(503, "Project/theme hierarchy is not available.");
        }
        const project = url?.searchParams?.get("project") ?? "";
        const includeArchived = url?.searchParams?.get("includeArchived") === "true";
        const limit = Number(url?.searchParams?.get("limit") ?? 40);
        if (project.length > 160 || !Number.isInteger(limit) || limit < 1 || limit > 60) {
          return fail(400, "Pass project up to 160 characters and limit of 1-60.");
        }
        return ok(await supervisor.getHierarchy({ project: project.trim() || null, includeArchived, limit }));
      }
      if (parts[0] === "active-work" && (parts.length === 1 || (parts.length === 2 && parts[1] === "scan") || (parts.length === 3 && (parts[2] === "act" || parts[2] === "verify")))) {
        if (parts.length === 1 && method === "GET") {
          if (typeof supervisor.getActiveWork !== "function") {
            return fail(503, "Active Work tracking is not available.");
          }
          const project = url?.searchParams?.get("project") ?? "";
          const theme = url?.searchParams?.get("theme") ?? "";
          const includeSnoozed = ["true", "1"].includes(url?.searchParams?.get("includeSnoozed") ?? "");
          const includeDone = ["true", "1"].includes(url?.searchParams?.get("includeDone") ?? "");
          const limit = Number(url?.searchParams?.get("limit") ?? 50);
          if (project.length > 160 || theme.length > 120 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
            return fail(400, "Pass project up to 160 chars, theme up to 120 chars, and limit of 1-100.");
          }
          return ok(await supervisor.getActiveWork({
            project: project.trim() || null,
            theme: theme.trim() || null,
            includeSnoozed,
            includeDone,
            limit
          }));
        }
        if (parts.length === 1 && method === "POST") {
          if (typeof supervisor.trackWork !== "function") {
            return fail(503, "Active Work tracking is not available.");
          }
          const body = await readObject(readBody);
          if (!body) return fail(400, "Send a JSON object describing the outcome, project, or customer to track.");
          try {
            const tracked = await supervisor.trackWork(body);
            const activeWork = typeof supervisor.getActiveWork === "function" ? await supervisor.getActiveWork() : null;
            return ok({ ...tracked, activeWork, state: state() });
          } catch (err) {
            return safeActiveWorkError(err, "Could not track Active Work.");
          }
        }
        if (parts.length === 2 && parts[1] === "scan") {
          if (method !== "POST") return fail(405, "Use POST.");
          if (typeof supervisor.scanActiveWork !== "function") {
            return fail(503, "Active Work inventory scan is not available.");
          }
          const body = (await readObject(readBody)) ?? {};
          try {
            const pass = await supervisor.scanActiveWork({
              ...(body.pageSize !== undefined ? { pageSize: Number(body.pageSize) } : {}),
              ...(body.maxRepoChecks !== undefined ? { maxRepoChecks: Number(body.maxRepoChecks) } : {}),
              ...(body.maxDecisionItems !== undefined ? { maxDecisionItems: Number(body.maxDecisionItems) } : {}),
              ...(body.maxPromptsPerPass !== undefined ? { maxPromptsPerPass: Number(body.maxPromptsPerPass) } : {}),
              resetCursor: body.resetCursor === true
            });
            const activeWork = typeof supervisor.getActiveWork === "function" ? await supervisor.getActiveWork() : null;
            return ok({ pass, activeWork, state: state() });
          } catch (err) {
            return safeActiveWorkError(err, "Active Work inventory scan failed.");
          }
        }
        if (parts.length === 3 && parts[2] === "verify") {
          if (method !== "POST") return fail(405, "Use POST.");
          if (!ID_PATTERN.test(parts[1])) return fail(400, "Bad Active Work id.");
          if (typeof supervisor.verifyGoalProgress !== "function") {
            return fail(503, "Goal verification is not available.");
          }
          const body = await readObject(readBody);
          if (!body) return fail(400, "Send a JSON object with { evidenceSummary, cursor }.");
          try {
            const result = await supervisor.verifyGoalProgress({
              id: parts[1],
              evidenceSummary: typeof body.evidenceSummary === "string" ? body.evidenceSummary : "",
              cursor: body.cursor && typeof body.cursor === "object" && !Array.isArray(body.cursor) ? body.cursor : null,
              ownerConfirmedDone: body.ownerConfirmedDone === true
            });
            const activeWork = typeof supervisor.getActiveWork === "function" ? await supervisor.getActiveWork() : null;
            return ok({ result, activeWork, state: state() });
          } catch (err) {
            return safeActiveWorkError(err, "Could not verify goal progress.");
          }
        }
        if (parts.length === 3 && parts[2] === "act") {
          if (method !== "POST") return fail(405, "Use POST.");
          if (!ID_PATTERN.test(parts[1])) return fail(400, "Bad Active Work id.");
          if (typeof supervisor.actActiveWork !== "function") {
            return fail(503, "Active Work actions are not available.");
          }
          const body = await readObject(readBody);
          if (!body || typeof body.op !== "string" || !body.op.trim()) {
            return fail(400, "Send a JSON object with { op }.");
          }
          try {
            const result = await supervisor.actActiveWork(parts[1], body, sendOptions);
            if (!result) return fail(404, "No Active Work item or proposal with that id.");
            const activeWork = typeof supervisor.getActiveWork === "function" ? await supervisor.getActiveWork() : null;
            return ok({ result, activeWork, state: state() });
          } catch (err) {
            return safeActiveWorkError(err, "Could not execute Active Work action.");
          }
        }
        return fail(405, "Method not allowed.");
      }
      if (parts[0] === "projects" && (parts.length === 1 || parts.length === 2)) {
        if (parts.length === 1 && method === "GET") {
          if (typeof supervisor.getOrganization !== "function") {
            return fail(503, "Project organization is not available.");
          }
          return ok({ organization: await supervisor.getOrganization() });
        }
        if (parts.length === 1 && method === "POST") {
          if (typeof supervisor.upsertProject !== "function") {
            return fail(503, "Project organization is not available.");
          }
          const body = await readObject(readBody);
          const name = typeof body?.name === "string" ? body.name.trim() : "";
          const theme = typeof body?.theme === "string" ? body.theme.trim() : null;
          const alias = typeof body?.alias === "string" ? body.alias.trim() : null;
          if (!name || name.length > 80) return fail(400, "Project name must be 1-80 characters.");
          if (theme && theme.length > 80) return fail(400, "Theme name must be up to 80 characters.");
          if (alias && alias.length > 80) return fail(400, "Alias must be up to 80 characters.");
          try {
            const res = await supervisor.upsertProject({ name, theme: theme || null, alias: alias || null });
            return ok({ ...res, state: state() });
          } catch (err) {
            return fail(400, String(err?.message ?? "Could not save project.").slice(0, 200));
          }
        }
        if (parts.length === 2 && method === "DELETE") {
          if (typeof supervisor.deleteProject !== "function") {
            return fail(503, "Project organization is not available.");
          }
          const projId = decodeURIComponent(parts[1]).trim();
          if (!projId || projId.length > 80) return fail(400, "Bad project id.");
          const res = await supervisor.deleteProject(projId);
          return ok({ ...res, state: state() });
        }
        return fail(405, "Use GET, POST, or DELETE.");
      }
      if (parts.length === 2 && parts[0] === "themes" && parts[1] === "sync") {
        if (method !== "POST") return fail(405, "Use POST.");
        if (typeof supervisor.syncThemes !== "function") {
          return fail(503, "Theme label sync is not available.");
        }
        const body = (await readObject(readBody)) ?? {};
        const project = typeof body.project === "string" ? body.project.trim() : "";
        if (project.length > 160) return fail(400, "project must be up to 160 characters.");
        if (body.pinnedAssignments !== undefined && body.pinnedAssignments !== null && (!Array.isArray(body.pinnedAssignments) || body.pinnedAssignments.length > 50)) {
          return fail(400, "pinnedAssignments must be an array of up to 50 items.");
        }
        try {
          const synced = await supervisor.syncThemes({
            project: project || null,
            dryRun: body.dryRun === true,
            pinnedAssignments: Array.isArray(body.pinnedAssignments) ? body.pinnedAssignments.slice(0, 50) : null
          });
          return ok({ result: synced, state: state() });
        } catch (err) {
          return fail(400, String(err?.message ?? "Theme label sync failed.").slice(0, 220));
        }
      }
      if (parts.length === 1 && parts[0] === "dispatch") {
        if (method !== "POST") return fail(405, "Use POST.");
        if (typeof supervisor.dispatchGoal !== "function") {
          return fail(503, "Manager goal dispatch is not available.");
        }
        const body = await readObject(readBody);
        const goal = typeof body?.goal === "string" ? body.goal.trim() : "";
        const project = typeof body?.project === "string" ? body.project.trim() : "";
        const theme = typeof body?.theme === "string" ? body.theme.trim() : "";
        const targetKey = typeof body?.targetKey === "string" ? body.targetKey.trim() : "";
        if (!goal || goal.length > 4000) return fail(400, "goal must be 1-4000 characters.");
        if (project.length > 160 || theme.length > 120) return fail(400, "project/theme too long.");
        if (targetKey && !THREAD_KEY.test(targetKey)) return fail(400, "Pass a valid targetKey.");
        const dispatchMode = typeof body?.mode === "string" ? body.mode.trim().toLowerCase() : "auto";
        if (!["preview", "auto", "execute", "force_new"].includes(dispatchMode)) {
          return fail(400, "mode must be preview, auto, execute, or force_new.");
        }
        try {
          const result = await supervisor.dispatchGoal({
            project: project || null,
            theme: theme || null,
            goal,
            mode: dispatchMode,
            targetKey: targetKey || null,
            serverId: typeof body?.serverId === "string" && body.serverId.trim() ? body.serverId.trim() : null,
            cwd: typeof body?.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : null,
            provider: typeof body?.provider === "string" && body.provider.trim() ? body.provider.trim() : null,
            model: typeof body?.model === "string" && body.model.trim() ? body.model.trim().slice(0, 120) : null,
            effort: typeof body?.effort === "string" && body.effort.trim() ? body.effort.trim().slice(0, 40) : null,
            ...(Array.isArray(body?.images) ? { images: body.images } : {}),
            ...sendOptions
          });
          return ok({ result, state: state() });
        } catch (err) {
          return fail(400, String(err?.message ?? "Could not dispatch goal.").slice(0, 220));
        }
      }
      if (parts.length === 1 && parts[0] === "repo-status") {
        if (method !== "GET") return fail(405, "Use GET.");
        if (typeof supervisor.inspectRepoStatus !== "function") {
          return fail(503, "Repository status inspection is not available.");
        }
        const repo = url?.searchParams?.get("repo") ?? "";
        const workspace = url?.searchParams?.get("workspace") ?? "";
        const limit = Number(url?.searchParams?.get("limit") ?? 15);
        if ((!repo.trim() && !workspace.trim()) || repo.length > 160 || workspace.length > 160 || !Number.isInteger(limit) || limit < 1 || limit > 30) {
          return fail(400, "Pass repo or workspace and a limit of 1-30.");
        }
        try {
          return ok(await supervisor.inspectRepoStatus({ repo: repo.trim() || null, workspace: workspace.trim() || null, limit }));
        } catch (err) {
          return fail(400, String(err?.message ?? "Could not inspect repository.").slice(0, 200));
        }
      }
      if (parts.length === 2 && parts[0] === "tasks" && parts[1] === "claim") {
        if (method !== "POST") return fail(405, "Use POST.");
        if (typeof supervisor.claimTask !== "function") {
          return fail(503, "Claiming tasks into coding sessions is not available.");
        }
        const body = await readObject(readBody);
        const taskId = typeof body?.taskId === "string" ? body.taskId.trim() : "";
        const title = typeof body?.title === "string" ? body.title.trim() : "";
        if (!taskId && (!title || title.length > 300)) {
          return fail(400, "Pass taskId or a title of 1-300 characters.");
        }
        if (taskId && !ID_PATTERN.test(taskId)) {
          return fail(400, "Bad taskId.");
        }
        const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
        if (prompt.length > 4000) return fail(400, "prompt must be up to 4000 characters.");
        try {
          const claimed = await supervisor.claimTask({
            taskId: taskId || null,
            title: title || null,
            description: typeof body?.description === "string" ? body.description.trim().slice(0, 4000) : "",
            workspace: typeof body?.workspace === "string" && body.workspace.trim() ? body.workspace.trim().slice(0, 160) : null,
            cwd: typeof body?.cwd === "string" && body.cwd.trim() ? body.cwd.trim().slice(0, 400) : null,
            serverId: typeof body?.serverId === "string" && body.serverId.trim() ? body.serverId.trim() : null,
            project: typeof body?.project === "string" && body.project.trim() ? body.project.trim().slice(0, 120) : null,
            subchannel: typeof body?.subchannel === "string" && body.subchannel.trim() ? body.subchannel.trim().slice(0, 120) : null,
            provider: typeof body?.provider === "string" && body.provider.trim() ? body.provider.trim().slice(0, 80) : null,
            model: typeof body?.model === "string" && body.model.trim() ? body.model.trim().slice(0, 120) : null,
            effort: typeof body?.effort === "string" && body.effort.trim() ? body.effort.trim().slice(0, 40) : null,
            labels: body?.labels ?? null,
            dependsOn: Array.isArray(body?.dependsOn) ? body.dependsOn.filter((id) => typeof id === "string" && ID_PATTERN.test(id)).slice(0, 20) : null,
            ...(Array.isArray(body?.images) ? { images: body.images } : {}),
            prompt: prompt || null
          });
          return ok({ task: claimed.task, session: claimed.session, state: state() });
        } catch (err) {
          return fail(400, String(err?.message ?? "Could not claim task into Paseo session.").slice(0, 220));
        }
      }
      if (parts.length === 2 && parts[0] === "sessions" && parts[1] === "start") {
        if (method !== "POST") return fail(405, "Use POST.");
        if (typeof supervisor.startPaseoSession !== "function") {
          return fail(503, "Starting Paseo sessions is not available.");
        }
        const body = await readObject(readBody);
        const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
        const workspace = typeof body?.workspace === "string" ? body.workspace.trim() : "";
        const cwd = typeof body?.cwd === "string" ? body.cwd.trim() : "";
        if (!prompt || prompt.length > 4000) return fail(400, "prompt must be 1-4000 characters.");
        if (workspace.length > 160 || cwd.length > 400) {
          return fail(400, "workspace or cwd is too long.");
        }
        try {
          const started = await supervisor.startPaseoSession({
            workspace: workspace || null,
            cwd: cwd || null,
            serverId: typeof body?.serverId === "string" && body.serverId.trim() ? body.serverId.trim() : null,
            title: typeof body?.title === "string" && body.title.trim() ? body.title.trim() : null,
            provider: typeof body?.provider === "string" && body.provider.trim() ? body.provider.trim() : null,
            model: typeof body?.model === "string" && body.model.trim() ? body.model.trim().slice(0, 120) : null,
            effort: typeof body?.effort === "string" && body.effort.trim() ? body.effort.trim().slice(0, 40) : null,
            modeId: typeof body?.modeId === "string" && body.modeId.trim() ? body.modeId.trim().slice(0, 60) : null,
            ...(Array.isArray(body?.images) ? { images: body.images } : {}),
            prompt
          });
          return ok({ session: started, state: state() });
        } catch (err) {
          return fail(400, String(err?.message ?? "Could not start Paseo session.").slice(0, 220));
        }
      }
      if (parts.length === 2 && parts[0] === "cards" && parts[1] === "batch") {
        if (method !== "POST") return fail(405, "Use POST.");
        if (typeof supervisor.batchActCards !== "function") {
          return fail(503, "Batch card actions are not available.");
        }
        const body = await readObject(readBody);
        if (!body) return fail(400, "Send a JSON object: { op, filter?, cardIds?, value? }.");
        const op = typeof body.op === "string" ? body.op.trim().toLowerCase() : "";
        if (!BATCH_OPS.has(op)) return fail(400, "Pass a valid batch op.");
        let filter = null;
        if (body.filter !== undefined && body.filter !== null) {
          filter = typeof body.filter === "string" ? body.filter.trim().toLowerCase() : "";
          if (!BATCH_FILTERS.has(filter)) return fail(400, "Pass a valid batch filter.");
        }
        let cardIds = null;
        if (body.cardIds !== undefined && body.cardIds !== null) {
          if (!Array.isArray(body.cardIds) || body.cardIds.length === 0 || body.cardIds.length > 25) {
            return fail(400, "cardIds must be an array of 1-25 valid card IDs.");
          }
          if (body.cardIds.some((id) => typeof id !== "string" || !CARD_ID_PATTERN.test(id))) {
            return fail(400, "Bad card id in cardIds.");
          }
          cardIds = body.cardIds;
        }
        if (!cardIds && !filter && op !== "merge_green" && op !== "fix_ci") {
          return fail(400, "Pass explicit cardIds or filter ('green_prs', 'ci_failed', 'questions', 'all').");
        }
        const value = typeof body.value === "string" ? body.value.trim() : null;
        if (value && value.length > REPLY_MAX) return fail(400, "Option value is too long.");
        try {
          const result = await supervisor.batchActCards({ op, filter, cardIds, value, ...sendOptions });
          return ok({ result, state: state() });
        } catch (err) {
          return fail(400, String(err?.message ?? "Batch card action failed.").slice(0, 220));
        }
      }
      if (parts.length === 1 && parts[0] === "preferences") {
        if (method !== "POST") return fail(405, "Use POST.");
        if (typeof supervisor.updatePreferences !== "function") {
          return fail(503, "Preferences are not available.");
        }
        const body = await readObject(readBody);
        if (!body) return fail(400, "Send a JSON object of preference updates.");
        const preferences = await supervisor.updatePreferences(body);
        return ok({ preferences, state: state() });
      }
      if (parts.length === 1 && parts[0] === "route") {
        if (method !== "POST") return fail(405, "Use POST.");
        if (typeof supervisor.routeIssue !== "function") {
          return fail(503, "Issue routing is not available.");
        }
        const body = await readObject(readBody);
        const text = typeof body?.text === "string" ? body.text.trim() : "";
        if (!text || text.length > SEND_MAX) return fail(400, `text must be 1-${SEND_MAX} characters.`);
        const confirmTarget = typeof body?.confirmTarget === "string" ? body.confirmTarget.trim() : null;
        if (confirmTarget && !THREAD_KEY.test(confirmTarget)) return fail(400, "Pass a valid thread key.");
        const result = await supervisor.routeIssue({
          text,
          confirmTarget,
          autoSend: body?.autoSend === true,
          ...sendOptions
        });
        return ok({ ...result, state: state() });
      }
      if (parts.length === 3 && parts[0] === "cards" && parts[2] === "act") {
        if (method !== "POST") return fail(405, "Use POST.");
        const cardId = pathCardId(parts[1]);
        if (!cardId) return fail(400, "Bad card id.");
        if (typeof supervisor.actCard !== "function") {
          return fail(503, "Card actions are not available.");
        }
        const body = (await readObject(readBody)) ?? {};
        const op = typeof body.op === "string" ? body.op.trim() : "primary";
        const value = typeof body.value === "string" ? body.value.trim() : null;
        const maxLen = op.toLowerCase() === "reply" ? REPLY_MAX : ANSWER_MAX;
        if (value && value.length > maxLen) return fail(400, "Option value is too long.");
        const outcome = await supervisor.actCard(cardId, {
          op,
          value,
          confirmed: body.confirmed === true,
          clarification: typeof body.clarification === "string" ? body.clarification : null,
          instructions: typeof body.instructions === "string" ? body.instructions : null,
          ...(Array.isArray(body.images) ? { images: body.images } : {}),
          ...sendOptions
        });
        if (!outcome) return fail(404, "Card or question is no longer open.", { state: state() });
        return ok({ result: outcome, state: state() });
      }
      if (parts.length === 1 && parts[0] === "state") {
        if (method !== "GET") return fail(405, "Use GET.");
        await supervisor.refresh?.();
        if (url?.searchParams?.get("reconcile") === "1" && typeof supervisor.reconcileOpenQuestions === "function") {
          await supervisor.reconcileOpenQuestions().catch(() => {});
        }
        return ok(state());
      }
      if (parts.length === 1 && parts[0] === "reconcile") {
        if (method !== "POST") return fail(405, "Use POST.");
        if (typeof supervisor.reconcileOpenQuestions !== "function") {
          return fail(503, "Question reconciliation is not available.");
        }
        const body = (await readObject(readBody)) ?? {};
        const reconciled = await supervisor.reconcileOpenQuestions({ force: body.force === true });
        return ok({ result: reconciled, state: state() });
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
        if (!MODES.includes(mode)) return fail(400, "Mode must be one of: " + MODES.join(", ") + ".");
        try {
          const applied = await supervisor.setMode(mode);
          if (applied !== mode || state().mode !== mode) return fail(503, "The fleet computer did not confirm the requested mode. Refresh and retry.", { state: state() });
        } catch {
          return fail(503, "Supervisor mode could not be confirmed and saved on the fleet computer. Check its connection and available disk space, then retry.", { state: state() });
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
        const images = Array.isArray(body?.images) ? body.images : null;
        const rawMessage = typeof body?.message === "string" ? body.message.trim() : "";
        const message = rawMessage || (images?.length ? "Please inspect the attached image(s)." : "");
        if (!THREAD_KEY.test(threadKey)) return fail(400, "Pass a thread key from the fleet state.");
        if (!message || message.length > SEND_MAX) return fail(400, `Message must be 1-${SEND_MAX} characters.`);
        if (typeof supervisor.sendOwnerMessage !== "function") return fail(503, "Sending is not available.");
        const idempotencyKey = typeof body?.idempotencyKey === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(body.idempotencyKey) ? body.idempotencyKey : null;
        const extraOpts = {
          ...sendOptions,
          ...(body?.queue === true ? { queue: true } : {}),
          ...(images?.length ? { images } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {})
        };
        const result = await supervisor.sendOwnerMessage(threadKey, message, extraOpts);
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
        // Everything the store keeps: a status filter must see old open items.
        if (method === "GET") return ok({ feedback: await supervisor.feedback({ limit: 500 }) });
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
        if (parts[2] === "settings") {
          if (method === "GET") {
            if (typeof supervisor.paseoSessionSettings !== "function") return fail(503, "Paseo session settings are not available.");
            const result = await supervisor.paseoSessionSettings(threadKey);
            if (result?.ok) return ok({ settings: result.settings });
            const status = result?.status === "wrong-target" ? 409 : result?.status === "unavailable" ? 503 : 400;
            return fail(status, result?.detail ?? "Paseo session settings could not be read.", { settings: result?.settings ?? null });
          }
          if (method !== "POST") return fail(405, "Use GET or POST.");
          const body = (await readObject(readBody)) ?? {};
          if (body.confirmed !== true) return fail(403, "An explicit owner confirmation is required.");
          if (typeof supervisor.updatePaseoSessionSettings !== "function") return fail(503, "Paseo session settings are not available.");
          const result = await supervisor.updatePaseoSessionSettings(threadKey, body, sendOptions);
          if (result?.ok) return ok({ settings: result.settings, detail: result.detail });
          const status = {
            unauthorized: 403,
            "wrong-target": 409,
            "stale-target": 409,
            pending: 409,
            busy: 409,
            unsupported: 422,
            invalid: 400,
            unavailable: 503,
            failed: 502,
            unconfirmed: 502
          }[result?.status] ?? 400;
          return fail(status, result?.detail ?? "Paseo session settings were not applied.", { settings: result?.settings ?? null });
        }
        if (parts[2] === "transcript") {
          if (method !== "GET") return fail(405, "Use GET.");
          if (typeof supervisor.readChatTranscript !== "function") return fail(503, "Transcript reading is not available.");
          const limit = Number(url?.searchParams?.get("limit") ?? 20);
          if (!Number.isInteger(limit) || limit < 1 || limit > 60) return fail(400, "limit must be 1-60.");
          try {
            const transcript = await supervisor.readChatTranscript({ key: threadKey, limit });
            return ok({ transcript });
          } catch (err) {
            const msg = String(err?.message ?? "No session found.");
            if (/no session found|could not read paseo chat/i.test(msg)) {
              return fail(404, msg.slice(0, 200));
            }
            return fail(400, msg.slice(0, 200));
          }
        }
        if (parts[2] === "organize") {
          if (method !== "POST") return fail(405, "Use POST.");
          if (typeof supervisor.organizeThread !== "function") {
            return fail(503, "Thread organization is not available.");
          }
          const body = (await readObject(readBody)) ?? {};
          const project = typeof body.project === "string" ? body.project.trim() : null;
          const theme = typeof body.theme === "string" ? body.theme.trim() : null;
          if (project && project.length > 80) return fail(400, "project must be up to 80 characters.");
          if (theme && theme.length > 80) return fail(400, "theme must be up to 80 characters.");
          try {
            const res = await supervisor.organizeThread(threadKey, { project: project || null, theme: theme || null });
            return ok({ ...res, state: state() });
          } catch (err) {
            return fail(400, String(err?.message ?? "Could not organize thread.").slice(0, 200));
          }
        }
        if (!THREAD_ACTIONS.has(parts[2])) return fail(404, "Unknown fleet route.");
        if (method !== "POST") return fail(405, "Use POST.");
        if (parts[2] === "push") {
          if (typeof supervisor.pushNow !== "function") return fail(503, "Push now is not available.");
          const result = await supervisor.pushNow(threadKey, sendOptions);
          return ok({ delivery: result?.delivery ?? null, action: result?.action ?? null, state: state() });
        }
        if (parts[2] === "failover") {
          if (typeof supervisor.switchPaseoProvider !== "function") return fail(503, "Provider failover is not available.");
          const body = (await readObject(readBody)) ?? {};
          const preferredProviders = Array.isArray(body.preferredProviders)
            ? body.preferredProviders.filter((p) => typeof p === "string").slice(0, 3)
            : undefined;
          const reason = typeof body.reason === "string" ? body.reason.slice(0, 240) : null;
          const result = await supervisor.switchPaseoProvider(threadKey, { preferredProviders, reason });
          if (!result?.ok) {
            return fail(400, result?.detail ?? "Could not switch Paseo provider.", { status: result?.status ?? "blocked", state: state() });
          }
          return ok({ result, state: state() });
        }
        if (parts[2] === "archive") {
          if (typeof supervisor.archiveThread !== "function") return fail(503, "Session archiving is not available.");
          const body = (await readObject(readBody)) ?? {};
          const result = await supervisor.archiveThread(threadKey, { confirmed: body.confirmed === true });
          if (!result?.ok) {
            return fail(result?.status === "confirmation_required" ? 409 : 400, result?.detail ?? "Could not archive coding session.", { status: result?.status ?? "blocked", state: state() });
          }
          return ok({ result, state: state() });
        }
        if (parts[2] === "unarchive") {
          if (typeof supervisor.unarchiveThread !== "function") return fail(503, "Session restore is not available.");
          const result = await supervisor.unarchiveThread(threadKey);
          if (!result?.ok) return fail(400, result?.detail ?? "Could not restore coding session.", { state: state() });
          return ok({ result, state: state() });
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
