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
    operations: Object.freeze(["ask"]),
    detail: "Sends an explicit tap-to-record voice question to the main"
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
    this.fetchImpl = (options.fetchImpl ?? globalThis.fetch).bind(globalThis);
  }

  status() {
    return {
      transcriptionConfigured: Boolean(this.apiKey),
      model: this.model
    };
  }

  async ask(body, nodeId) {
    const enrollment = this.nodeRegistry?.enrollment?.(nodeId);
    if (!enrollment || enrollment.platform !== EVEN_G2_PLATFORM) {
      throw new G2ChannelError("forbidden_node", 403, "This node is not an enrolled Even G2.");
    }
    if (!this.agentHost?.handleMessage) throw new G2ChannelError("agent_unavailable", 503, "OpenAGI chat is not available.");
    const wav = decodeAndValidateWav(body?.audioBase64);
    const question = await this.transcribe(wav, body?.language);
    const conversationId = boundedOptional(body?.conversationId, 200);
    if (!conversationId) {
      throw new G2ChannelError("invalid_conversation", 400, "A stable G2 conversation id is required.");
    }
    const nodeNamespace = createHash("sha256").update(nodeId, "utf8").digest("base64url");
    const conversationNamespace = createHash("sha256").update(conversationId, "utf8").digest("base64url");
    const sessionId = `node:${nodeNamespace}:${conversationNamespace}:main`;
    const turn = await this.agentHost.handleMessage({
      channel: "g2",
      from: `node:${nodeId}:${conversationNamespace}`,
      agentId: "main",
      sessionId,
      text: question,
      metadata: {
        sourceNodeId: nodeId,
        nodePlatform: EVEN_G2_PLATFORM,
        nodeName: enrollment.name ?? "Even G2",
        audioDurationSeconds: Number(((wav.length - 44) / 32_000).toFixed(3))
      }
    });
    appendJsonLine(this.eventsPath, {
      at: nowIso(), op: "ask", nodeId, sessionId: turn.session?.id ?? sessionId, audioBytes: wav.length
    });
    return { question, reply: turn.reply, sessionId: turn.session?.id ?? sessionId };
  }

  async transcribe(wav, language) {
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
        signal: AbortSignal.timeout(60_000)
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
