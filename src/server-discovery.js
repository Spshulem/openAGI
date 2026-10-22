import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { reverse } from "node:dns/promises";

// Advertise only a configured phone-reachable origin. Never widen the HTTP
// bind, publish credentials, or infer that a discovered host is trusted.
export function discoveryOrigin(raw) {
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    if (["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0", "[::]"].includes(url.hostname)) return null;
    return url.origin;
  } catch { return null; }
}

export async function phoneDiscoveryOrigin(raw, { reverseLookup = reverse } = {}) {
  const origin = discoveryOrigin(raw);
  if (!origin) return null;
  const url = new URL(origin);
  const octets = url.hostname.split(".").map(Number);
  // iOS ATS accepts a tailnet DNS name over HTTP, but not its raw CGNAT IP.
  // Resolve only the already-configured main; never enumerate a tailnet.
  if (url.protocol === "http:" && octets.length === 4 && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) {
    let timer;
    try {
      const names = await Promise.race([
        Promise.resolve().then(() => reverseLookup(url.hostname)).catch(() => []),
        new Promise((resolve) => { timer = setTimeout(() => resolve([]), 500); })
      ]);
      const name = names.find((entry) => /^[a-z0-9.-]+\.ts\.net\.?$/i.test(entry));
      if (name) url.hostname = name.replace(/\.$/, "");
    } finally { clearTimeout(timer); }
  }
  return url.origin;
}

export function advertiseServer({ url, platform = process.platform, spawnImpl = spawn, name = hostname() } = {}) {
  const origin = discoveryOrigin(url);
  if (!origin || !["darwin", "linux"].includes(platform)) return () => {};
  const parsed = new URL(origin);
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  const label = `OpenAGI · ${String(name).replace(/[\x00-\x1f\x7f]/g, "").slice(0, 40)}`;
  const txt = ["v=1", `url=${origin}`];
  let child;
  try {
    // dns-sd ships with macOS. Linux discovery is optional when Avahi is
    // installed; absence must never prevent an agent from starting.
    child = platform === "darwin"
      ? spawnImpl("/usr/bin/dns-sd", ["-R", label, "_openagi._tcp", "local", port, ...txt], { stdio: "ignore" })
      : spawnImpl("avahi-publish-service", ["-s", label, "_openagi._tcp", port, ...txt], { stdio: "ignore" });
    child.on("error", () => {});
    child.unref?.();
  } catch { return () => {}; }
  const stop = () => {
    process.off("exit", stop);
    try { child.kill(); } catch { /* already exited */ }
  };
  process.once("exit", stop);
  return stop;
}
