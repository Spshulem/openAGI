import http from "node:http";
import { searchMessages } from "./imessage-bridge.js";

// iMessage node service — runs on the Mac that has chat.db (Full Disk Access),
// and exposes SEARCH over the network so a remote OpenAGI "main" can answer
// questions about the user's iMessages. Bearer-token gated; the main calls it
// via the `search_imessages` tool.
//
//   POST /search { query?, handle?, days?, limit? } -> { results: [...] }
//   GET  /health -> { ok: true }
//
// The brain stays on the main; this only serves read-only message search.

export function createImessageServer({ token, dbPath } = {}) {
  return http.createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    // Auth (constant-ish check). /health stays open for reachability probes.
    const url = new URL(req.url, "http://x");
    if (url.pathname !== "/health") {
      const auth = req.headers.authorization ?? "";
      const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!token || presented !== token) return send(401, { error: "unauthorized" });
    }

    if (req.method === "GET" && url.pathname === "/health") return send(200, { ok: true, service: "imessage" });

    if (req.method === "POST" && url.pathname === "/search") {
      let raw = "";
      req.on("data", (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
      req.on("end", async () => {
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch { return send(400, { error: "bad json" }); }
        try {
          const results = await searchMessages(dbPath, {
            query: body.query ?? "",
            handle: body.handle ?? body.person ?? null,
            days: body.days != null ? Number(body.days) : null,
            limit: Math.min(Number(body.limit) || 30, 100)
          });
          send(200, { results });
        } catch (error) {
          const msg = /too large|cantopen|unable to open/i.test(error.message)
            ? "can't read chat.db — grant Full Disk Access to this process"
            : error.message;
          send(500, { error: msg });
        }
      });
      return;
    }
    send(404, { error: "not found" });
  });
}
