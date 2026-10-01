import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { inspectClientHelloSni } from "./codex-tls-sni.js";

const ALLOWED_HOSTS = new Set(["auth.openai.com", "chatgpt.com"]);
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_TUNNEL_BYTES = 16 * 1024 * 1024;
const MAX_CONNECTIONS = 8;

// This broker never terminates TLS or receives an OAuth token. It only
// authorizes a hostname, resolves it outside the sandbox and tunnels bytes.
export function createCodexEgressBroker({ profileDir, lookup = dns.lookup, dial = net.connect } = {}) {
  if (!path.isAbsolute(profileDir ?? "") || fs.realpathSync(profileDir) !== profileDir) {
    throw new Error("Codex egress requires an absolute, real private profile.");
  }
  const socketPath = path.join(profileDir, "egress.sock");
  const sockets = new Set();
  let server = null;
  let identity = null;
  let opening = null;

  function deny(socket, status = 403) {
    if (socket.destroyed) return;
    socket.end(`HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Unavailable"}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
  }

  async function handle(socket) {
    // Refused sockets must not remain open outside the tracked shutdown set.
    if (sockets.size >= MAX_CONNECTIONS) {
      socket.on("error", () => {});
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(5_000, () => socket.destroy());
    let header = Buffer.alloc(0);
    const onData = async (chunk) => {
      socket.pause();
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf("\r\n\r\n");
      if ((end < 0 && header.length > MAX_HEADER_BYTES) || end + 4 > MAX_HEADER_BYTES) return deny(socket);
      if (end < 0) { socket.resume(); return; }
      socket.off("data", onData);
      const text = header.subarray(0, end).toString("ascii");
      const [requestLine, ...headers] = text.split("\r\n");
      const match = /^CONNECT ([a-z0-9.-]+):443 HTTP\/1\.[01]$/.exec(requestLine);
      const hostname = match?.[1];
      if (!hostname || !ALLOWED_HOSTS.has(hostname)
        || headers.some((line) => !/^(host|proxy-connection|connection):\s*[^\r\n]*$/i.test(line))
        || headers.some((line) => /^host:/i.test(line) && !new RegExp(`^host:\\s*${hostname.replaceAll(".", "\\.")}(?::443)?$`, "i").test(line))) {
        return deny(socket);
      }
      try {
        const addresses = await lookup(hostname, { family: 4, all: true });
        if (!Array.isArray(addresses) || addresses.length === 0
          || addresses.some((entry) => entry.family !== 4 || !publicIpv4(entry.address))) return deny(socket);
        if (socket.destroyed) return;
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        let hello = Buffer.alloc(0);
        const onHello = (data) => {
          socket.pause();
          hello = Buffer.concat([hello, data]);
          if (hello.length > 16_389) { socket.destroy(); return; }
          const verdict = inspectClientHelloSni(hello, hostname);
          if (verdict === "incomplete") { socket.resume(); return; }
          socket.off("data", onHello);
          if (verdict !== "accepted" || socket.destroyed) { socket.destroy(); return; }
          let upstream;
          try { upstream = dial({ host: addresses[0].address, family: 4, port: 443 }); }
          catch { socket.destroy(); return; }
          sockets.add(upstream);
          upstream.once("close", () => sockets.delete(upstream));
          upstream.on("error", () => { if (!socket.destroyed) socket.destroy(); });
          upstream.setTimeout(180_000, () => upstream.destroy());
          upstream.once("connect", () => {
            if (socket.destroyed) { upstream.destroy(); return; }
            let sent = hello.length;
            let received = 0;
            socket.on("data", (next) => { sent += next.length; if (sent > MAX_TUNNEL_BYTES) { socket.destroy(); upstream.destroy(); } });
            upstream.on("data", (next) => { received += next.length; if (received > MAX_TUNNEL_BYTES) { socket.destroy(); upstream.destroy(); } });
            upstream.write(hello);
            socket.setTimeout(180_000, () => socket.destroy());
            socket.pipe(upstream);
            upstream.pipe(socket);
            socket.resume();
          });
        };
        socket.on("data", onHello);
        const remainder = header.subarray(end + 4);
        if (remainder.length) onHello(remainder);
        else socket.resume();
      } catch { if (!socket.destroyed) deny(socket, 503); }
    };
    socket.on("data", onData);
  }

  return {
    socketPath,
    async start() {
      if (server) throw new Error("Codex egress broker already started.");
      if (fs.existsSync(socketPath)) throw new Error("Codex egress socket already exists.");
      server = net.createServer((socket) => { void handle(socket); });
      opening = (async () => {
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(socketPath, () => { server.off("error", reject); resolve(); });
        });
        fs.chmodSync(socketPath, 0o600);
        identity = fs.lstatSync(socketPath);
      })();
      try {
        await opening;
      } catch (error) {
        server.close();
        server = null;
        throw error;
      } finally {
        opening = null;
      }
    },
    async close() {
      if (opening) await opening.catch(() => {});
      if (!server) return;
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      server = null;
      try {
        const current = fs.lstatSync(socketPath);
        if (identity && current.isSocket() && current.ino === identity.ino && current.dev === identity.dev) fs.unlinkSync(socketPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      identity = null;
    }
  };
}

function publicIpv4(value) {
  if (net.isIP(value) !== 4) return false;
  const [a, b, c] = value.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 192 && b === 0 && c === 2) || (a === 203 && b === 0 && c === 113));
}
