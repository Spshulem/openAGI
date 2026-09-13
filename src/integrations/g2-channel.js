import path from "node:path";
import { createHash } from "node:crypto";
import { appendJsonLine, ensureDir } from "../file-utils.js";
import { resolveDataDir } from "../data-dir.js";
import { nowIso } from "../utils.js";

const MAX_WAV_BYTES = 44 + (16_000 * 2 * 30);
const MIN_WAV_BYTES = 44 + 3_200;

export const EVEN_G2_PLATFORM = "even_g2";
export const EVEN_G2_CAPABILITIES = Object.freeze([
  Object.freeze({
    id: "g2-voice-input",
    ready: true,
    operations: Object.freeze(["ask", "listen"]),
    detail: "Sends tap-to-record or opt-in foreground wake-listening voice to the main"
  }),
  Object.freeze({
    id: "g2-text-display",
    ready: true,
    operations: Object.freeze(["show-answer"]),
    detail: "Shows paginated OpenAGI answers on the glasses"
  })
]);

export class G2ChannelError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = "G2ChannelError";
    this.code = code;
    this.status = status;
  }
}

export class G2Channel {
  constructor(options = {}) {
    this.agentHost = options.agentHost;
    this.nodeRegistry = options.nodeRegistry;
    this.dir = options.dir ?? path.join(resolveDataDir(), "channels", "g2");
    ensureDir(this.dir);
    this.eventsPath = path.join(this.dir, "events.jsonl");
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? null;
    this.baseUrl = String(options.baseUrl ?? process.env.OPENAI_TRANSCRIPTION_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.model = options.model ?? process.env.OPENAI_TRANSCRIPTION_MODEL ?? "gpt-4o-mini-transcribe";
    this.deepgramApiKey = options.deepgramApiKey ?? process.env.DEEPGRAM_API_KEY ?? null;
    this.speechGrants = new Map();
    this.fetchImpl = (options.fetchImpl ?? globalThis.fetch).bind(globalThis);
  }

  status() {
    return {
      transcriptionConfigured: Boolean(this.apiKey),
      liveTranscriptionConfigured: Boolean(this.deepgramApiKey),
      model: this.model
    };
  }

  async speechToken(body, nodeId) {
    this.assertEnrolled(nodeId);
    const model = body?.model ?? "nova-3";
    if (!["nova-3", "nova-2"].includes(model)) throw new G2ChannelError("invalid_speech_model", 400, "Choose Nova 3 or Nova 2 for live speech.");
    if (!this.deepgramApiKey) throw new G2ChannelError("live_speech_not_configured", 503, "Set DEEPGRAM_API_KEY on your OpenAGI main, or select OpenAI buffered speech on the phone.");
    const now = Date.now();
    for (const [id, entry] of this.speechGrants) if (entry.until <= now) this.speechGrants.delete(id);
    const entry = this.speechGrants.get(nodeId) ?? { until: now + 60_000, count: 0 };
    if (entry.count >= 6 || (!this.speechGrants.has(nodeId) && this.speechGrants.size >= 1000)) {
      throw new G2ChannelError("speech_rate_limit", 429, "Too many speech reconnects. Wait one minute before retrying.");
    }
    entry.count++; this.speechGrants.set(nodeId, entry);
    let response;
    try {
      response = await this.fetchImpl("https://api.deepgram.com/v1/auth/grant", {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Token ${this.deepgramApiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ ttl_seconds: 30 })
      });
      const payload = await response.json();
      if (!response.ok || typeof payload.access_token !== "string" || payload.access_token.length > 8192
          || !Number.isFinite(payload.expires_in) || payload.expires_in <= 0 || payload.expires_in > 30) throw new Error("grant failed");
      // Only a short-lived voice JWT leaves the main. Never persist or log it.
      return { accessToken: payload.access_token, expiresIn: payload.expires_in, model };
    } catch {
      throw new G2ChannelError("live_speech_unavailable", 502, "Could not start Deepgram live speech. Check the main's Deepgram key has Member access and available credit, or select buffered speech.");
    }
  }

  async ask(body, nodeId, options = {}) {
    const enrollment = this.assertEnrolled(nodeId);
    const textOnly = typeof body?.text === "string";
    if (textOnly && (body.audioBase64 !== undefined || !body.text.trim() || body.text.length > 4000)) {
      throw new G2ChannelError("invalid_question", 400, "Send one question of at most 4000 characters.");
    }
    const wav = textOnly ? Buffer.alloc(44) : decodeAndValidateWav(body?.audioBase64);
    const conversationId = boundedOptional(body?.conversationId, 200);
    if (!conversationId) {
      throw new G2ChannelError("invalid_conversation", 400, "A stable G2 conversation id is required.");
    }
    this.nodeRegistry.touchEnrollment?.(nodeId);
    options.signal?.throwIfAborted();
    if (!textOnly) options.onProgress?.({ stage: "transcribing" });
    const question = textOnly ? body.text.trim() : await this.transcribe(wav, body?.language, options.signal);
    options.signal?.throwIfAborted();
    options.onProgress?.({ stage: "transcribed", question });
    return this.answer(question, wav, conversationId, nodeId, enrollment, options);
  }

  async listen(body, nodeId) {
    const enrollment = this.assertEnrolled(nodeId);
    const wav = decodeAndValidateWav(body?.audioBase64);
    const conversationId = boundedOptional(body?.conversationId, 200);
    if (!conversationId) {
      throw new G2ChannelError("invalid_conversation", 400, "A stable G2 conversation id is required.");
    }
    this.nodeRegistry.touchEnrollment?.(nodeId);
    const wakePhrase = boundedOptional(body?.wakePhrase, 40) ?? "open agi";
    const triggerMode = body?.triggerMode === "wake_or_question" ? "wake_or_question" : "wake_only";
    const question = await this.transcribe(wav, body?.language);
    const wakeDetected = includesPhrase(question, wakePhrase);
    const directQuestion = triggerMode === "wake_or_question" && looksLikeQuestion(question);
    const forced = body?.forceAnswer === true;
    if (!forced && !wakeDetected && !directQuestion) {
      return { question, triggered: false, armed: false, reason: "no_trigger" };
    }
    const prompt = wakeDetected ? removePhrase(question, wakePhrase) : question;
    if (!prompt) {
      return { question, triggered: false, armed: true, reason: "wake_phrase_only" };
    }
    if (body?.transcribeOnly === true) return { question, prompt, triggered: true, armed: false };
    const result = await this.answer(prompt, wav, conversationId, nodeId, enrollment);
    return { ...result, triggered: true, armed: false };
  }

  assertEnrolled(nodeId) {
    const enrollment = this.nodeRegistry?.enrollment?.(nodeId);
    if (!enrollment || enrollment.platform !== EVEN_G2_PLATFORM) {
      throw new G2ChannelError("forbidden_node", 403, "This node is not an enrolled Even G2.");
    }
    if (!this.agentHost?.handleMessage) throw new G2ChannelError("agent_unavailable", 503, "OpenAGI chat is not available.");
    return enrollment;
  }

  async answer(question, wav, conversationId, nodeId, enrollment, options = {}) {
    const nodeNamespace = createHash("sha256").update(nodeId, "utf8").digest("base64url");
    const conversationNamespace = createHash("sha256").update(conversationId, "utf8").digest("base64url");
    const sessionId = options.continuation ? this.sessionIdFor(nodeId, conversationId, options.continuation)
      : `node:${nodeNamespace}:${conversationNamespace}:main`;
    const store = this.agentHost.store;
    if (store?.saveSession) {
      const session = store.getSession(sessionId);
      store.saveSession({ ...session, metadata: { ...session.metadata, g2NodeId: nodeId } });
    }
    const turn = await this.agentHost.handleMessage({
      channel: "g2",
      from: `node:${nodeId}:${conversationNamespace}`,
      agentId: "main",
      sessionId,
      text: question,
      metadata: {
        sourceNodeId: nodeId,
        ...(options.requestId ? { requestId: options.requestId } : {}),
        nodePlatform: EVEN_G2_PLATFORM,
        nodeName: enrollment.name ?? "Even G2",
        audioDurationSeconds: Number(((wav.length - 44) / 32_000).toFixed(3))
      }
    }, options);
    appendJsonLine(this.eventsPath, {
      at: nowIso(), op: "ask", nodeId, sessionId: turn.session?.id ?? sessionId, audioBytes: wav.length
    });
    return { question, reply: turn.reply, sessionId: turn.session?.id ?? sessionId };
  }

  sessionIdFor(nodeId, conversationId, continuation) {
    this.assertEnrolled(nodeId);
    const prefix = g2SessionPrefix(nodeId);
    if (continuation !== undefined) {
      const sessionId = typeof continuation === "string" && continuation.startsWith("g2:") ? continuation.slice(3) : "";
      if (!sessionId.startsWith(prefix) || !/^[\w-]{43}:main$/.test(sessionId.slice(prefix.length)))
        throw new G2ChannelError("invalid_conversation", 403, "That conversation does not belong to this G2.");
      const session = this.agentHost.store?.getSession(sessionId);
      if (!isG2Session(session, nodeId)) throw new G2ChannelError("invalid_conversation", 404, "This G2 conversation was not found.");
      return sessionId;
    }
    return `${prefix}${createHash("sha256").update(conversationId, "utf8").digest("base64url")}:main`;
  }

  history(nodeId, { continuation, offset = 0, query = "" } = {}) {
    this.assertEnrolled(nodeId);
    const store = this.agentHost.store;
    if (!store?.listSessions) throw new G2ChannelError("history_unavailable", 503, "Main history is not configured.");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000 || typeof query !== "string" || query.length > 200)
      throw new G2ChannelError("invalid_history", 400, "Invalid history page.");
    if (continuation) {
      const id = this.sessionIdFor(nodeId, "", continuation), session = store.getSession(id);
      const publicMessages = session.messages.filter(m => ["user", "assistant"].includes(m.role) && m.channel === "g2" && typeof m.content === "string");
      const end = Math.max(0, publicMessages.length - offset), start = Math.max(0, end - 30);
      return { continuation, messages: publicMessages.slice(start, end).map(m => ({ id: m.id, role: m.role, text: m.content.slice(0, 16000), at: m.createdAt })),
        nextOffset: start > 0 ? offset + 30 : null, archivedOnMain: session.metadata?.historyArchived === true };
    }
    const matches = [], prefix = g2SessionPrefix(nodeId);
    for (const summary of store.listSessions({ prefix, limit: 200 })) {
      if (!summary.id.startsWith(prefix) || summary.recoveryNeeded) continue;
      // Project one bounded session at a time; never retain hundreds of full
      // conversation files just to build a twenty-row history page.
      const s = store.getSession(summary.id);
      if (!isG2Session(s, nodeId)) continue;
      const messages = s.messages.filter(m => ["user", "assistant"].includes(m.role) && m.channel === "g2" && typeof m.content === "string");
      const item = { continuation: `g2:${s.id}`, title: (messages.find(m => m.role === "user")?.content ?? "Conversation").slice(0, 160),
        preview: (messages.at(-1)?.content ?? "").slice(0, 240), at: s.updatedAt };
      if (`${item.title} ${item.preview}`.toLowerCase().includes(query.toLowerCase())) matches.push(item);
    }
    return { conversations: matches.slice(offset, offset + 20), nextOffset: matches.length > offset + 20 ? offset + 20 : null,
      searchScope: "Question and reply previews from this G2’s 200 most recently updated active conversations; full archives remain on main." };
  }

  async transcribe(wav, language, signal) {
    if (!this.apiKey) throw new G2ChannelError("transcription_not_configured", 503, "OpenAI transcription is not configured on OpenAGI.");
    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "question.wav");
    form.append("model", this.model);
    const boundedLanguage = boundedOptional(language, 20);
    if (boundedLanguage) form.append("language", boundedLanguage);
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000)
      });
    } catch {
      throw new G2ChannelError("transcription_unavailable", 502, "Speech transcription is temporarily unavailable.");
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new G2ChannelError("transcription_failed", 502, "OpenAGI could not transcribe that question.");
    const text = boundedOptional(payload?.text, 4_000);
    if (!text) throw new G2ChannelError("empty_transcription", 422, "I did not hear a question. Try again a little closer to the microphone.");
    return text;
  }
}

function g2SessionPrefix(nodeId) { return `node:${createHash("sha256").update(nodeId, "utf8").digest("base64url")}:`; }
function isG2Session(session, nodeId) {
  return session?.id?.startsWith(g2SessionPrefix(nodeId)) && (session.metadata?.g2NodeId === nodeId
    || session.messages?.some(m => m.channel === "g2" && m.role === "user" && m.metadata?.sourceNodeId === nodeId));
}

function normalizedWords(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function includesPhrase(text, phrase) {
  const matcher = phraseMatcher(phrase);
  return matcher ? matcher.test(String(text ?? "")) : false;
}

function removePhrase(text, phrase) {
  const matcher = phraseMatcher(phrase, true);
  if (!matcher) return String(text ?? "").trim();
  return String(text ?? "").replace(matcher, "").trim();
}

function phraseMatcher(phrase, consumePunctuation = false) {
  const words = normalizedWords(phrase).split(" ").filter(Boolean).map(escapeRegExp);
  if (!words.length) return null;
  const suffix = consumePunctuation ? "[\\s,;:.!?—-]*" : "";
  return new RegExp(`\\b${words.join("[^a-zA-Z0-9]*")}\\b${suffix}`, "i");
}

function looksLikeQuestion(text) {
  const clean = normalizedWords(text);
  if (!clean) return false;
  if (String(text).trim().endsWith("?")) return true;
  return /^(who|what|when|where|why|how|which|whose|can|could|would|should|will|is|are|am|was|were|do|does|did|may|might|tell me|show me|explain)\b/.test(clean);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeAndValidateWav(value) {
  if (typeof value !== "string" || value.length > Math.ceil(MAX_WAV_BYTES / 3) * 4 + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new G2ChannelError("invalid_audio", 400, "Question audio is missing or invalid.");
  }
  const wav = Buffer.from(value, "base64");
  if (wav.length < MIN_WAV_BYTES || wav.length > MAX_WAV_BYTES
      || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE"
      || wav.toString("ascii", 12, 16) !== "fmt " || wav.readUInt16LE(20) !== 1
      || wav.readUInt16LE(22) !== 1 || wav.readUInt32LE(24) !== 16_000
      || wav.readUInt16LE(34) !== 16 || wav.toString("ascii", 36, 40) !== "data"
      || wav.readUInt32LE(40) !== wav.length - 44) {
    throw new G2ChannelError("invalid_audio", 400, "G2 audio must be a 16 kHz mono PCM WAV of at most 30 seconds.");
  }
  return wav;
}

function boundedOptional(value, max) {
  if (typeof value !== "string") return null;
  const clean = value.trim().replace(/\0/g, "");
  return clean ? clean.slice(0, max) : null;
}
