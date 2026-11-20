// A phone that loses its /message stream (backgrounded, locked, network
// drop) must be able to send the same turn again without running it twice,
// and to see whether a turn it cannot hear any more is still running.
//
// The client names each turn with its own request id. While that turn runs,
// LiveTurns holds it, so a repeat of the same id attaches to it instead of
// starting another. Once it has ended, its user record and terminal assistant
// record (both carry metadata.requestId) say how it ended, so a repeat
// replays that outcome. Neither path calls the model again.

const STAGE = /^[a-z_-]{1,40}$/;

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
    const turn = { sessionId, requestId, stage: "queued", startedAt: new Date().toISOString(), listeners: new Set() };
    if (listener) turn.listeners.add(listener);
    const emit = (kind, data) => {
      for (const each of turn.listeners) {
        try { each(kind, data); } catch { /* one detached listener must not stop the turn */ }
      }
    };
    this.turns.set(key, turn);
    turn.promise = (async () => {
      try {
        return await start({
          onProgress: (raw) => {
            if (typeof raw?.stage === "string" && STAGE.test(raw.stage)) turn.stage = raw.stage;
            emit("progress", raw);
          },
          onTextDelta: (raw) => emit("delta", raw)
        });
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
