// Fixed, non-interactive bridge to an operator-installed agent-supervisor.
// No shell, no transcript replay, no alternate LLM supervisor, no writer kills.
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import crypto from "node:crypto";

const sessionId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/;
const safeText = (value, max = 160) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
const fingerprint = (target) => crypto.createHash("sha256").update(JSON.stringify([
  target.provider, target.id, target.cwd, target.file, target.sendVia, target.pid, target.peerName
])).digest("hex");

// Tokens may only reach the configured local bridge. Redirects are forbidden;
// a stalled or unbounded response cannot consume the daemon's event loop.
export async function localBridgeFetch(input, options = {}) {
  const url = new URL(input);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || url.username || url.password || !["/api/status", "/api/prompt"].includes(url.pathname)) {
    throw new Error("The supervisor bridge must use a local HTTP endpoint.");
  }
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000);
  const response = await fetch(url, { ...options, signal, redirect: "error" });
  const reader = response.body?.getReader();
  const chunks = [];
  let length = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 1024 * 1024) throw new Error("Bridge response exceeded its limit.");
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
  }
  return new Response(Buffer.concat(chunks), { status: response.status, headers: { "content-type": "application/json" } });
}

export async function handleSupervisorRequest(request, dependencies) {
  if (request?.version !== 1 || !["list", "inspect", "reply"].includes(request.operation)) throw new Error("Invalid operation.");
  const { lib, attach, inspect, fetchImpl = localBridgeFetch } = dependencies;
  const sessions = await lib.discoverSessions({ recentHours: 24, limit: 100 });
  const targets = attach.annotateTargets(sessions, attach.claudeAttachments(attach.readClaudeRegistry()));
  let config = null;
  try { config = await lib.readG2Config(request.stateFile); } catch { /* discovery works without a delivery connection */ }
  const canReply = (target) => Boolean(config && target.sendVia === "even-terminal");
  const dto = (target) => ({ provider: target.provider, sessionId: target.id,
    project: safeText(target.project), label: safeText(target.label), status: target.status,
    attentionBasis: target.reason === "last turn ended with a question" || target.status === "stuck" ? "heuristic" : "provider",
    lastActivityAt: target.lastActivityAt, model: null,
    route: canReply(target) ? "local-bridge" : "owning-app", replyAvailable: canReply(target), fingerprint: fingerprint(target) });
  if (request.operation === "list") return { sessions: targets.map(dto) };
  if (!["claude", "codex"].includes(request.provider) || !sessionId.test(request.sessionId ?? "")) throw new Error("Exact target required.");
  const matches = targets.filter((item) => item.provider === request.provider && item.id === request.sessionId);
  if (matches.length !== 1) throw new Error("The exact session is missing or ambiguous.");
  const target = matches[0];
  if (request.operation === "inspect") {
    const records = lib.readSessionRecords(target.file, target.provider);
    return { turns: inspect.extractTurns(records, target.provider, 6).map(({ role, text }) => ({ role, text: String(text).slice(-4_000) })) };
  }
  if (!canReply(target) || request.fingerprint !== fingerprint(target) || !path.isAbsolute(target.cwd ?? "")
    || typeof request.message !== "string" || !request.message.trim() || request.message.length > 4000 || request.message.includes("\0")) {
    throw new Error("The target or approved reply is no longer valid.");
  }
  const resultTarget = { provider: target.provider, sessionId: target.id };
  const bridge = { ...config, provider: target.provider, cwd: target.cwd,
    url: target.provider === "codex" ? config.codexUrl ?? config.url : config.url };
  const status = await lib.getG2Status(bridge, target.id, fetchImpl);
  if (!["idle", "missing"].includes(status?.state)) {
    return { ...resultTarget, status: "blocked", note: "The provider is busy or awaiting a permission decision. Use its owning app; no reply was sent." };
  }
  const result = await lib.postG2Prompt(bridge, request.message, target.id, fetchImpl);
  if (result?.sessionId !== target.id || (result.provider && result.provider !== target.provider)) throw new Error("Unexpected delivery target.");
  return { ...resultTarget, status: "accepted", note: "The bridge accepted this instruction. Completion and any provider permission requests must still be checked." };
}

async function main() {
  let length = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 32 * 1024) throw new Error("Request too large.");
    chunks.push(chunk);
  }
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!path.isAbsolute(request.backendDir ?? "") || (request.stateFile && !path.isAbsolute(request.stateFile))) throw new Error("Absolute operator paths required.");
  const [lib, attach, inspect] = await Promise.all(["lib.mjs", "attach.mjs", "inspect.mjs"].map((file) =>
    import(pathToFileURL(path.join(request.backendDir, file)).href)));
  const result = await handleSupervisorRequest(request, { lib, attach, inspect });
  process.stdout.write(JSON.stringify({ ok: true, result }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Never forward backend exceptions: they may include tokens or private text.
    process.stdout.write(JSON.stringify({ ok: false }));
    process.exitCode = 1;
  });
}
