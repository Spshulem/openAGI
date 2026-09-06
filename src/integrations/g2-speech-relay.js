import WebSocket, { WebSocketServer } from "ws";

const PATH = "/nodes/g2/speech";
const PROTOCOL = "openagi-g2-speech";
const MAX_AUDIO_BACKLOG = 64_000;

// The websocket upgrade bypasses the HTTP handler, so it MUST self-authenticate
// with an enrolled G2 token before opening any provider connection. No URL tokens,
// owner credentials, arbitrary destinations, or provider keys from the client.
export function attachG2SpeechRelay(server, { nodeRegistry, getChannel, upstreamFactory = (url, options) => new WebSocket(url, options) }) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_AUDIO_BACKLOG, handleProtocols: () => PROTOCOL });
  const active = new Map();
  const attempts = new Map();
  let closing = false;

  const upgrade = (req, socket, head) => {
    const deny = status => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    let url;
    try { url = new URL(req.url, "http://localhost"); } catch { return deny(400); }
    if (url.pathname !== PATH) return deny(404);
    if (closing || req.method !== "GET") return deny(503);
    const protocols = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map(value => value.trim());
    if (protocols.length !== 2 || protocols[0] !== PROTOCOL || !/^[A-Za-z0-9_-]{43}$/.test(protocols[1])) return deny(403);
    const token = protocols[1];
    const enrollment = nodeRegistry.enrollmentForToken(token);
    if (!enrollment || enrollment.platform !== "even_g2") return deny(403);
    const nodeId = enrollment.nodeId;
    const channel = getChannel();
    if (!channel?.deepgramApiKey) return deny(503);
    const model = url.searchParams.get("model") ?? "nova-3";
    const wakePhrase = url.searchParams.get("wakePhrase") ?? "";
    if (!["nova-3", "nova-2"].includes(model) || wakePhrase.length > 40
        || [...url.searchParams.keys()].some(key => !["model", "wakePhrase"].includes(key))
        || url.searchParams.getAll("model").length > 1 || url.searchParams.getAll("wakePhrase").length > 1) return deny(400);
    if (active.has(nodeId) || active.size >= 32) return deny(429);
    const now = Date.now();
    for (const [id, attempt] of attempts) if (attempt.until <= now) attempts.delete(id);
    const attempt = attempts.get(nodeId) ?? { count: 0, until: now + 60_000 };
    if (attempt.count >= 6 || (!attempts.has(nodeId) && attempts.size >= 1000)) return deny(429);
    attempt.count++; attempts.set(nodeId, attempt);
    try {
      wss.handleUpgrade(req, socket, head, client => {
        active.set(nodeId, client);
        connect(client, { nodeId, token, model, wakePhrase, key: channel.deepgramApiKey });
      });
    } catch { socket.destroy(); }
  };

  function connect(client, { nodeId, token, model, wakePhrase, key }) {
    let upstream;
    let done = false;
    let ready = false;
    let draining = false;
    let alive = true;
    let audioBudget = MAX_AUDIO_BACKLOG;
    let budgetAt = Date.now();
    let controlBudget = 20;
    let controlAt = Date.now();
    let openTimer;
    let drainTimer;
    let closeTimer;
    let heartbeat;

    const cleanup = (code = 1011, message = "Live speech disconnected. Retry listening.", normal = false) => {
      if (done) return;
      done = true;
      clearTimeout(openTimer); clearTimeout(drainTimer); clearInterval(heartbeat);
      // Retain the active slot until the peer closes, bounded by a kill timer.
      if (upstream && upstream.readyState !== WebSocket.CLOSED) upstream.terminate();
      if (client.readyState === WebSocket.OPEN) {
        if (!normal) client.send(JSON.stringify({ type: "Error", message }));
        client.close(code, normal ? "Speech finished" : "Speech paused");
        closeTimer = setTimeout(() => client.terminate(), 1000); closeTimer.unref();
      } else { client.terminate(); active.delete(nodeId); }
    };
    const fail = (message, code = 1011) => cleanup(code, message);
    const sendClient = text => {
      if (client.readyState !== WebSocket.OPEN || client.bufferedAmount + Buffer.byteLength(text) > 128_000) {
        fail("Transcript delivery fell behind. Listening paused."); return;
      }
      client.send(text, error => { if (error) fail("Transcript connection interrupted."); });
    };
    client.on("error", () => fail("Speech connection interrupted."));
    client.on("close", () => { cleanup(); clearTimeout(closeTimer); active.delete(nodeId); });
    client.on("pong", () => { alive = true; });
    client.on("message", (data, binary) => {
      if (done) return;
      if (!nodeRegistry.authenticate(nodeId, token)) { fail("G2 access was revoked. Listening stopped.", 1008); return; }
      if (!ready || draining) { fail("Audio arrived outside an active speech stream.", 1008); return; }
      if (binary) {
        const now = Date.now();
        audioBudget = Math.min(MAX_AUDIO_BACKLOG, audioBudget + Math.max(0, now - budgetAt) * 32); budgetAt = now;
        if (!data.length || data.length % 2 || data.length > audioBudget || upstream.bufferedAmount + data.length > MAX_AUDIO_BACKLOG) {
          fail("Speech upload fell behind or exceeded real-time PCM limits. Listening paused.", 1008); return;
        }
        audioBudget -= data.length;
        upstream.send(data, { binary: true }, error => { if (error) fail("Speech upload interrupted."); });
      } else {
        if (data.length > 128) { fail("Invalid speech control.", 1008); return; }
        const now = Date.now();
        controlBudget = Math.min(20, controlBudget + Math.max(0, now - controlAt) / 1000); controlAt = now;
        if (--controlBudget < 0) { fail("Too many speech control messages.", 1008); return; }
        let control;
        try { control = JSON.parse(data.toString()); } catch { fail("Invalid speech control.", 1008); return; }
        if (!control || Object.keys(control).length !== 1 || !["KeepAlive", "CloseStream"].includes(control.type)) { fail("Invalid speech control.", 1008); return; }
        if (control.type === "CloseStream") {
          draining = true;
          drainTimer = setTimeout(() => fail("Speech finalization took too long. Question was not sent."), 5000);
        }
        upstream.send(JSON.stringify(control), error => { if (error) fail("Speech control interrupted."); });
      }
    });

    const params = new URLSearchParams({ model, encoding: "linear16", sample_rate: "16000", channels: "1", language: "en", interim_results: "true", endpointing: "500", utterance_end_ms: "1000", vad_events: "true", smart_format: "true", mip_opt_out: "true" });
    if (model === "nova-3" && wakePhrase.trim()) params.set("keyterm", wakePhrase.trim());
    try {
      upstream = upstreamFactory(`wss://api.deepgram.com/v1/listen?${params}`, {
        headers: { Authorization: `Token ${key}` }, handshakeTimeout: 10_000,
        maxPayload: 128_000, perMessageDeflate: false, followRedirects: false
      });
    } catch { fail("Could not open Deepgram speech. Check the main's speech configuration."); return; }
    openTimer = setTimeout(() => fail("Deepgram did not connect within 10 seconds."), 10_000);
    upstream.on("open", () => {
      if (done) return;
      clearTimeout(openTimer); ready = true;
      sendClient(JSON.stringify({ type: "Ready", transport: "relay" }));
    });
    upstream.on("message", (data, binary) => {
      if (done || binary) return;
      // Allow only public transcription fields. Do not relay raw provider errors,
      // metadata, billing/account information, headers, or model credentials.
      let event;
      try { event = JSON.parse(data.toString()); } catch { fail("Invalid speech provider response."); return; }
      if (event?.type === "Error") { fail("Deepgram rejected the speech stream. Check the main's key, model and credit."); return; }
      if (event?.type === "Results") {
        const transcript = event.channel?.alternatives?.[0]?.transcript;
        if (typeof transcript !== "string" || transcript.length > 8000 || !Number.isFinite(event.start) || !Number.isFinite(event.duration)) { fail("Invalid speech provider response."); return; }
        sendClient(JSON.stringify({ type: "Results", is_final: event.is_final === true, speech_final: event.speech_final === true, start: event.start, duration: event.duration, channel: { alternatives: [{ transcript }] } }));
      } else if (event?.type === "UtteranceEnd" || event?.type === "SpeechStarted") sendClient(JSON.stringify({ type: event.type }));
    });
    upstream.on("error", () => fail("Deepgram live speech failed. Check the main's speech key, credit and network."));
    upstream.on("close", code => { if (!done) cleanup(draining && code === 1000 ? 1000 : 1011, "Deepgram disconnected. Retry listening.", draining && code === 1000); });
    heartbeat = setInterval(() => {
      if (!nodeRegistry.authenticate(nodeId, token)) { fail("G2 access was revoked. Listening stopped.", 1008); return; }
      if (!alive) { fail("Phone disconnected. Listening stopped."); return; }
      alive = false; client.ping();
    }, 10_000);
    heartbeat.unref();
  }

  server.on("upgrade", upgrade);
  return {
    close() {
      closing = true; server.off("upgrade", upgrade);
      for (const client of active.values()) client.terminate();
      wss.close();
    }
  };
}
