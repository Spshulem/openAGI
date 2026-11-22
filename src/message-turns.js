// A phone that loses its /message stream (backgrounded, locked, network
// drop) must be able to send the same turn again without running it twice,
// and to see whether a turn it cannot hear any more is still running.
//
// The client names each turn with its own request id. While that turn runs,
// LiveTurns holds it, so a repeat of the same id attaches to it instead of
// starting another. Once it has ended, its user record and terminal assistant
// record (both carry metadata.requestId) say how it ended, so a repeat
// replays that outcome. Neither path calls the model again.
//
// The owner can also stop a running turn to send a correction first
// (`interruptTurn`). That aborts the turn's signal; AgentHost stops before
// the next model hop or tool call. A tool already running is not cancelled
// and nothing is rolled back: the answer says whether the turn has stopped
// yet, so no client ever reports an interrupt that did not happen.

const STAGE = /^[a-z_-]{1,40}$/;
const TOOL = /^[\w.:-]{1,100}$/;

// The abort reason for an owner's interrupt. AgentHost reads it off the
// signal (not off whatever error a provider threw while aborting) to record
// the turn as stopped rather than failed.
export const OWNER_INTERRUPTED = "OWNER_INTERRUPTED";
export function ownerInterruptReason() {
  const error = new Error("Stopped by the owner to send a new message.");
  error.name = "AbortError";
  error.code = OWNER_INTERRUPTED;
  return error;
}
export function isOwnerInterrupt(signal) {
  return Boolean(signal?.aborted && signal.reason?.code === OWNER_INTERRUPTED);
}

export class LiveTurns {
  constructor() {
    this.turns = new Map();
  }

  static key(sessionId, requestId) {
    return `${sessionId}\u0000${requestId}`;
  }

  get(sessionId, requestId) {
    return this.turns.get(LiveTurns.key(sessionId, requestId)) ?? null;
  }

  // The turns still running in one session, for its history response.
  list(sessionId) {
    return [...this.turns.values()]
      .filter((turn) => turn.sessionId === sessionId)
      .map(({ requestId, stage, startedAt }) => ({ requestId, stage, startedAt }));
  }

  // Runs start(hooks) as the one live turn for this id. `listener` is
  // subscribed before start runs, so the caller hears even a synchronous
  // first progress event. The turn leaves the registry once it settles.
  run(sessionId, requestId, start, listener = null) {
    const key = LiveTurns.key(sessionId, requestId);
    const controller = new AbortController();
    const turn = {
      sessionId, requestId, stage: "queued", tool: null, startedAt: new Date().toISOString(),
      listeners: new Set(), controller, settled: null
    };
    if (listener) turn.listeners.add(listener);
    const emit = (kind, data) => {
      for (const each of turn.listeners) {
        try { each(kind, data); } catch { /* one detached listener must not stop the turn */ }
      }
    };
    this.turns.set(key, turn);
    turn.promise = (async () => {
      try {
        const result = await start({
          signal: controller.signal,
          onProgress: (raw) => {
            if (typeof raw?.stage === "string" && STAGE.test(raw.stage)) {
              turn.stage = raw.stage;
              // The action a hop is running now, so an interrupt can say what
              // it is waiting on. Cleared by any stage that names no tool.
              turn.tool = typeof raw.tool === "string" && TOOL.test(raw.tool) ? raw.tool : null;
            }
            emit("progress", raw);
          },
          onTextDelta: (raw) => emit("delta", raw)
        });
        turn.settled = { status: "complete" };
        return result;
      } catch (error) {
        turn.settled = isOwnerInterrupt(controller.signal)
          ? { status: "interrupted" }
          : { status: "failed", code: typeof error?.code === "string" ? error.code : null };
        throw error;
      } finally {
        if (this.turns.get(key) === turn) this.turns.delete(key);
      }
    })();
    return turn;
  }

  subscribe(turn, listener) {
    turn.listeners.add(listener);
    return () => turn.listeners.delete(listener);
  }
}

const sleep = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); });

// Stop one running turn so the owner's next message runs instead, and say
// truthfully where it got to. Idempotent: a repeat (double tap, a resend
// after a dropped response) aborts nothing new and reports the same state.
//   interrupted  the turn has stopped; nothing more of it will run
//   stopping     asked to stop; it ends after the action running now (tool)
//   finished     it ended on its own first (outcome: complete | failed |
//                interrupted-by-restart); nothing was interrupted
//   not_found    main has no turn by this id in this conversation
// A message sent after any of these runs after the turn has fully ended:
// AgentHost serializes turns per session.
export async function interruptTurn({ liveTurns, store, sessionId, requestId, settleMs = 4_000 }) {
  const live = liveTurns?.get(sessionId, requestId) ?? null;
  if (live) {
    if (!live.controller.signal.aborted) live.controller.abort(ownerInterruptReason());
    const tool = live.tool;
    await Promise.race([live.promise.then(() => {}, () => {}), sleep(Math.max(0, settleMs))]);
    if (!live.settled) return { status: "stopping", requestId, ...(tool ? { tool } : {}) };
    return settledOutcome(live.settled, requestId);
  }
  const stored = storedTurn(store, sessionId, requestId);
  if (!stored) return { status: "not_found", requestId };
  if (stored.status === "failed" && stored.code === "stopped") return { status: "interrupted", requestId };
  return { status: "finished", outcome: stored.status, requestId };
}

function settledOutcome(settled, requestId) {
  if (settled.status === "interrupted") return { status: "interrupted", requestId };
  return { status: "finished", outcome: settled.status, requestId };
}

// How a turn that is no longer running ended, from the session's own
// records: null when this id never reached the session (never accepted).
export function storedTurn(store, sessionId, requestId) {
  if (!store?.getSession || !sessionId || !requestId) return null;
  const messages = store.getSession(sessionId)?.messages ?? [];
  const userIndex = messages.findIndex((m) => m?.role === "user" && m.metadata?.requestId === requestId);
  if (userIndex < 0) return null;
  const reply = messages.slice(userIndex + 1)
    .find((m) => m?.role === "assistant" && m.metadata?.requestId === requestId);
  const messageCount = messages.length;
  if (!reply) return { status: "interrupted", sessionId, messageCount };
  if (reply.metadata?.status === "failed") {
    return { status: "failed", sessionId, messageCount, code: reply.metadata.code ?? "agent_failed", message: reply };
  }
  return { status: "complete", sessionId, messageCount, message: reply };
}

// The /message result a repeat of a finished turn returns: the same shape a
// live turn's `final` carries, marked as a replay.
export function replayedResult(stored) {
  return {
    id: stored.message.id,
    createdAt: stored.message.createdAt,
    agent: { id: stored.message.agentId ?? "main" },
    session: { id: stored.sessionId, messageCount: stored.messageCount },
    reply: stored.message.content,
    replayed: true
  };
}

// The error a repeat of a failed or interrupted turn rethrows, so the
// transport reports it the same way it reports a live failure.
export function replayedFailure(stored, requestId) {
  const error = new Error(stored.status === "interrupted"
    ? "This turn stopped before it finished (OpenAGI restarted). Send it again to retry."
    : String(stored.message?.content ?? "OpenAGI couldn't complete that request."));
  error.code = stored.status === "interrupted" ? "interrupted" : (stored.code ?? "agent_failed");
  error.openagiSessionId = stored.sessionId;
  error.openagiRequestId = requestId;
  error.openagiFailurePersisted = stored.status !== "interrupted";
  error.openagiReplayed = true;
  return error;
}
