#!/usr/bin/env node
// Runnable local server for the OpenAGI Supervisor P0 iOS UX Stress-Test Workbench.
// Usage:
//   node scripts/supervisor-ux-stress-test.mjs [--port 4319] [--host 127.0.0.1]

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.resolve(__dirname, "../examples/supervisor-ux-stress-test.html");

const args = process.argv.slice(2);
function readArg(flag, fallback) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const host = readArg("--host", process.env.HOST || "127.0.0.1");
const port = Number(readArg("--port", process.env.PORT || "4319"));

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/api/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, artifact: "supervisor-ux-stress-test", htmlPath }));
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/supervisor-ux-stress-test.html") {
    try {
      const body = fs.readFileSync(htmlPath, "utf8");
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      });
      res.end(body);
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(`Failed to read ${htmlPath}: ${err.message}`);
    }
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

server.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log(`OpenAGI Supervisor UX Stress Test running at http://${host}:${actualPort}/`);
  console.log(`Standalone HTML file: ${htmlPath}`);
});
