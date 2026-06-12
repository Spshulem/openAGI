#!/usr/bin/env node
// OpenAGI CLI. Run the daemon headless (e.g. on a Distiller / Pi over SSH) and
// make it the MAIN that holds every integration; point other devices at it as
// thin "nodes" with `--remote` / `openagi pair`.
//
//   openagi serve [--host H] [--port P]   run the daemon (the main brain)
//   openagi chat [message]                send a message (interactive if none)
//   openagi status                        health + provider + task counts
//   openagi doctor                        diagnose setup/connection, print fixes
//   openagi setup                         print the dashboard/setup URL + token
//   openagi pair <url> [--token T]        save a remote main as this node's target
//   openagi unpair                        forget the saved remote main
//   openagi tick                          fire a scheduler tick
//
// Global flags: --remote <url>  --token <token>  --json
// Target resolution: --remote flag > OPENAGI_REMOTE env > saved pairing > local.

import readline from "node:readline";
import { resolveDataDir } from "../src/data-dir.js";
import { resolveTarget, CliClient, runDoctor, writeNodeConfig, clearNodeConfig, normalizeBase } from "../src/cli-client.js";

const RESET = "\x1b[0m", DIM = "\x1b[2m", BOLD = "\x1b[1m", GREEN = "\x1b[32m", RED = "\x1b[31m", YELLOW = "\x1b[33m";
const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? code + s + RESET : s);

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") flags.json = true;
    else if (a === "--remote") flags.remote = argv[++i];
    else if (a === "--token") flags.token = argv[++i];
    else if (a === "--host") flags.host = argv[++i];
    else if (a === "--port") flags.port = argv[++i];
    else if (a === "-h" || a === "--help") flags.help = true;
    else positional.push(a);
  }
  return { flags, positional };
}

function makeClient(flags) {
  const target = resolveTarget({ remote: flags.remote, token: flags.token });
  return { client: new CliClient(target), target };
}

async function cmdServe(flags) {
  const { startServer } = await import("../src/boot.js");
  const { address, host } = await startServer({ host: flags.host, port: flags.port });
  console.log(c(GREEN, `OpenAGI main listening at ${address.url}`));
  if (host === "127.0.0.1") {
    console.log(c(DIM, "Bound to localhost only. To let other devices connect as nodes, run with --host 0.0.0.0"));
    console.log(c(DIM, "(auth token required — set one via `openagi setup` first)."));
  } else {
    console.log(c(DIM, `Reachable from your network. Nodes: \`openagi pair http://<this-host>:${address.url.split(":").pop()} --token <token>\``));
  }
  // Keep the process alive; the server holds the event loop open.
}

async function cmdChat(positional, flags) {
  const { client, target } = makeClient(flags);
  const msg = positional.join(" ").trim();
  if (msg) {
    const res = await client.chat(msg);
    if (flags.json) { console.log(JSON.stringify(res.json ?? { error: res.error ?? res.status }, null, 2)); return res.ok ? 0 : 1; }
    if (!res.ok) { console.error(c(RED, `✗ ${res.error ?? "HTTP " + res.status}`)); return 1; }
    console.log(res.json?.reply ?? "(no reply)");
    return 0;
  }
  // Interactive REPL.
  console.log(c(DIM, `chatting with ${target.remote ? "main" : "local daemon"} at ${target.url} — Ctrl-D to exit`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: c(BOLD, "you ▸ ") });
  rl.prompt();
  for await (const line of rl) {
    const text = line.trim();
    if (!text) { rl.prompt(); continue; }
    const res = await client.chat(text);
    if (!res.ok) console.error(c(RED, `✗ ${res.error ?? "HTTP " + res.status}`));
    else console.log(c(GREEN, "openagi ▸ ") + (res.json?.reply ?? "(no reply)"));
    rl.prompt();
  }
  console.log();
  return 0;
}

async function cmdStatus(flags) {
  const { client, target } = makeClient(flags);
  const res = await client.health();
  if (flags.json) { console.log(JSON.stringify(res.json ?? { error: res.error ?? res.status }, null, 2)); return res.ok ? 0 : 1; }
  if (!res.ok) {
    console.error(c(RED, `✗ ${target.url} — ${res.status === 401 ? "unauthorized (bad/missing token)" : res.error ?? "HTTP " + res.status}`));
    return 1;
  }
  const h = res.json ?? {};
  const ah = h.status?.agentHost ?? {};
  const mem = h.status?.memory ?? {};
  console.log(`${c(GREEN, "●")} ${target.remote ? "main" : "local"} ${c(DIM, target.url)}`);
  console.log(`  provider:   ${ah.providerConfigured ? c(GREEN, ah.provider) : c(YELLOW, "not configured")}`);
  console.log(`  setup:      ${h.firstRun ? c(YELLOW, "incomplete (run `openagi setup`)") : c(GREEN, "complete")}`);
  console.log(`  memory:     short ${mem.short ?? 0} · medium ${mem.medium ?? 0} · long ${mem.long ?? 0}`);
  const tasks = await client.tasks();
  if (tasks.ok) {
    const s = tasks.json?.stats?.user ?? {};
    console.log(`  tasks:      ${s.pending ?? 0} pending · ${s.total ?? 0} total`);
  }
  return 0;
}

async function cmdDoctor(flags) {
  const { client } = makeClient(flags);
  const result = await runDoctor(client);
  if (flags.json) { console.log(JSON.stringify(result, null, 2)); return result.ok ? 0 : 1; }
  for (const check of result.checks) {
    const mark = check.ok ? c(GREEN, "✓") : c(RED, "✗");
    console.log(`${mark} ${c(BOLD, check.name)}  ${check.detail}`);
    if (!check.ok && check.fix) console.log(`    ${c(YELLOW, "→ " + check.fix)}`);
  }
  console.log(result.ok ? c(GREEN, "\nAll checks passed.") : c(YELLOW, "\nSome checks need attention (see → above)."));
  return result.ok ? 0 : 1;
}

async function cmdSetup(flags) {
  // Headless boxes can't open a browser; print the URL + token so the user can
  // open it from any device on the network.
  const { client, target } = makeClient(flags);
  const res = await client.health();
  const setupUrl = `${target.url}/setup`;
  if (!res.ok && res.status === 0 && !target.remote) {
    console.log(c(YELLOW, "The local daemon isn't running. Start it first: ") + c(BOLD, "openagi serve"));
    console.log(c(DIM, `Then open ${setupUrl} in a browser.`));
    return 1;
  }
  console.log(`Open the setup wizard: ${c(BOLD, setupUrl)}`);
  if (target.token) console.log(c(DIM, `Auth token (for the login prompt / nodes): ${target.token}`));
  else console.log(c(DIM, "No auth token known here — the wizard will generate one on first run."));
  return 0;
}

function cmdPair(positional, flags) {
  const url = positional[0];
  if (!url) { console.error(c(RED, "usage: openagi pair <main-url> [--token <token>]")); return 1; }
  const file = writeNodeConfig({ remote: normalizeBase(url), token: flags.token ?? null }, resolveDataDir());
  console.log(c(GREEN, `✓ paired with ${normalizeBase(url)}`));
  console.log(c(DIM, `saved to ${file}. This device is now a node; \`openagi chat/status/doctor\` target the main.`));
  if (!flags.token) console.log(c(YELLOW, "No --token given. If the main enforces auth, re-run with --token <main's OPENAGI_AUTH_TOKEN>."));
  return 0;
}

function cmdUnpair() {
  const removed = clearNodeConfig(resolveDataDir());
  console.log(removed ? c(GREEN, "✓ unpaired — commands target the local daemon again.") : c(DIM, "no pairing was set."));
  return 0;
}

async function cmdUpdate(positional, flags) {
  const { client, target } = makeClient(flags);
  const checkOnly = positional.includes("--check") || flags.check;
  // GET = dry check, POST = apply + restart. The daemon owns the git checkout.
  const res = checkOnly ? await client.request("GET", "/control/update") : await client.request("POST", "/control/update");
  if (flags.json) { console.log(JSON.stringify(res.json ?? { error: res.error ?? res.status }, null, 2)); return res.ok ? 0 : 1; }
  if (!res.ok) { console.error(c(RED, `✗ ${res.error ?? "HTTP " + res.status}`)); return 1; }
  const r = res.json ?? {};
  if (checkOnly) {
    if (r.updateAvailable) console.log(c(YELLOW, `↑ update available: ${r.current} → ${r.latest} (${r.behind} commit${r.behind === 1 ? "" : "s"} behind on ${r.branch})`));
    else console.log(c(GREEN, `✓ up to date (${r.current} on ${r.branch ?? "?"})`) + (r.reason ? c(DIM, ` — ${r.reason}`) : ""));
    return 0;
  }
  if (r.updated) {
    console.log(c(GREEN, `✓ updated ${r.from} → ${r.to}`) + (r.depsChanged ? c(DIM, " (deps reinstalled)") : ""));
    console.log(c(DIM, `${target.remote ? "main" : "daemon"} is restarting with the new code…`));
  } else {
    console.log(c(GREEN, `✓ ${r.reason ?? "nothing to do"}`));
  }
  return 0;
}

async function cmdTick(flags) {
  const { client } = makeClient(flags);
  const res = await client.tick();
  if (flags.json) { console.log(JSON.stringify(res.json ?? { error: res.error }, null, 2)); return res.ok ? 0 : 1; }
  console.log(res.ok ? c(GREEN, "✓ tick fired") : c(RED, `✗ ${res.error ?? "HTTP " + res.status}`));
  return res.ok ? 0 : 1;
}

function printHelp() {
  console.log(`${c(BOLD, "openagi")} — proactive local agent · CLI

${c(BOLD, "Run the main (the brain — holds all integrations):")}
  openagi serve [--host 0.0.0.0] [--port 43210]

${c(BOLD, "Use it (local, or a remote main):")}
  openagi chat [message]      send a message; interactive REPL if no message
  openagi status              health, provider, memory, task counts
  openagi doctor              diagnose setup/connection and print fixes
  openagi setup               print the dashboard/setup URL + token
  openagi update [--check]    fast-forward + restart (or just check); set
                              OPENAGI_AUTO_UPDATE=1 for a daily auto-update
  openagi tick                fire a scheduler tick

${c(BOLD, "Turn this device into a node of a remote main:")}
  openagi pair <main-url> [--token T]    save the main as this device's target
  openagi unpair                         forget it

${c(BOLD, "Global flags:")} --remote <url>  --token <token>  --json

${c(DIM, "Target precedence: --remote > OPENAGI_REMOTE env > saved pairing > local daemon.")}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseArgs(rest);
  if (!cmd || flags.help || cmd === "help") { printHelp(); return cmd ? 0 : 1; }
  try {
    switch (cmd) {
      case "serve": return await cmdServe(flags);
      case "chat": return await cmdChat(positional, flags);
      case "status": return await cmdStatus(flags);
      case "doctor": return await cmdDoctor(flags);
      case "setup": return await cmdSetup(flags);
      case "pair": return cmdPair(positional, flags);
      case "unpair": return cmdUnpair();
      case "update": return await cmdUpdate(positional, flags);
      case "tick": return await cmdTick(flags);
      default:
        console.error(c(RED, `unknown command: ${cmd}`));
        printHelp();
        return 1;
    }
  } catch (error) {
    console.error(c(RED, `error: ${error.message}`));
    return 1;
  }
}

main().then((code) => {
  // `serve` keeps the loop alive; everything else exits with its status.
  if (typeof code === "number" && process.argv[2] !== "serve") process.exit(code);
});
