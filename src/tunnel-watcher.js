// Tunnel watcher (C2). Tails the cloudflared log file and auto-updates
// OPENAGI_PUBLIC_URL when a new *.trycloudflare.com URL appears.
//
// Pairs with scripts/install-tunnel-launchd.sh (Mac) or a Linux systemd
// cloudflared unit. The watcher updates process.env AND persists to .env so
// subsequent boots have the right URL until the next rotation.
//
// Triggered events:
//   - "tunnel-url" with { url } — emitted on AppState SSE so dashboard refreshes
//   - "tunnel-changed" — when the URL replaces a previously-known one (notification)

import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { ensureDir, writeTextAtomic } from "./file-utils.js";
import { nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";

const QUICK_TUNNEL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const POLL_MS = 2000;

export class TunnelWatcher extends EventEmitter {
  constructor(options = {}) {
    super();
    this.dataDir = options.dataDir ?? resolveDataDir();
    this.logPath = options.logPath ?? path.join(this.dataDir, "tunnel.log");
    this.envPath = options.envPath ?? path.join(this.dataDir, ".env");
    this.timer = null;
    this.lastUrl = process.env.OPENAGI_PUBLIC_URL ?? null;
    this.lastSize = 0;
  }

  start() {
    if (this.timer) return;
    ensureDir(path.dirname(this.logPath));
    this.timer = setInterval(() => this.tickSafe(), POLL_MS);
    this.tickSafe();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tickSafe() {
    try { this.tick(); } catch (error) {
      this.emit("error", error);
    }
  }

  tick() {
    let stat;
    try { stat = fs.statSync(this.logPath); } catch { return; }
    if (stat.size === 0 || stat.size === this.lastSize) return;
    const start = stat.size > this.lastSize ? this.lastSize : 0;
    const fd = fs.openSync(this.logPath, "r");
    try {
      const length = stat.size - start;
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, start);
      this.lastSize = stat.size;
      const matches = buf.toString("utf8").match(new RegExp(QUICK_TUNNEL_RE, "g"));
      if (!matches?.length) return;
      const candidate = matches[matches.length - 1];
      if (candidate === this.lastUrl) return;
      const previous = this.lastUrl;
      this.applyUrl(candidate);
      this.emit("tunnel-url", { url: candidate, previous, at: nowIso() });
      if (previous && previous !== candidate) {
        this.emit("tunnel-changed", { url: candidate, previous });
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  applyUrl(url) {
    process.env.OPENAGI_PUBLIC_URL = url;
    this.lastUrl = url;
    let text = "";
    try { text = fs.readFileSync(this.envPath, "utf8"); } catch { /* fresh */ }
    const lines = text.split(/\r?\n/);
    let replaced = false;
    const out = lines.map((line) => {
      if (line.startsWith("OPENAGI_PUBLIC_URL=")) {
        replaced = true;
        return `OPENAGI_PUBLIC_URL=${url}`;
      }
      return line;
    });
    if (!replaced) {
      // Trim trailing blanks then append
      while (out.length && out[out.length - 1] === "") out.pop();
      out.push(`OPENAGI_PUBLIC_URL=${url}`);
    }
    writeTextAtomic(this.envPath, `${out.join("\n")}\n`, 0o600);
  }
}
