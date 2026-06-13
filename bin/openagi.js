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
    else if (a === "--allow") flags.allow = argv[++i];
    else if (a === "--allow-chat") flags.allowChat = argv[++i];
    else if (a === "--check") flags.check = true;
    else if (a === "--from") flags.from = argv[++i];
    else if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--respond") flags.respond = argv[++i];
    else if (a === "--capture") flags.capture = argv[++i];
    else if (a === "--trigger") flags.trigger = argv[++i];
    else if (a === "--days") flags.days = argv[++i];
    else if (a === "--limit") flags.limit = argv[++i];
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

async function cmdMigrate(positional, flags) {
  const { detectSource, defaultSourceDir, extract, applyMigration } = await import("../src/migrate.js");
  const { resolveDataDir } = await import("../src/data-dir.js");
  let source = positional[0];
  if (!source) {
    source = detectSource();
    if (!source) { console.error(c(RED, "couldn't detect an OpenClaw or Hermes install — pass `openagi migrate <openclaw|hermes> --from <dir>`")); return 1; }
    console.log(c(DIM, `detected: ${source}`));
  }
  const dir = flags.from ?? defaultSourceDir(source);
  let extracted;
  try { extracted = extract(source, dir); }
  catch (error) { console.error(c(RED, `✗ ${error.message}`)); return 1; }

  console.log(`${c(BOLD, `Migrate ${source}`)} from ${c(DIM, dir)}`);
  console.log(`  agent name:  ${extracted.agentName ? c(GREEN, extracted.agentName) : c(YELLOW, "(none found)")}`);
  console.log(`  persona:     ${extracted.persona ? c(GREEN, "yes") : c(YELLOW, "none")}`);
  console.log(`  memories:    ${extracted.memories.length}`);
  console.log(`  telegram:    ${extracted.telegram.length ? c(GREEN, extracted.telegram.map((t) => t.label).join(", ")) : "none"}`);
  for (const n of extracted.notes) console.log(c(DIM, `  note: ${n}`));

  if (flags.dryRun || flags.check) { console.log(c(YELLOW, "\n(dry run — nothing applied. Re-run without --dry-run to migrate.)")); return 0; }

  const { client, target } = makeClient(flags);
  const health = await client.health();
  if (!health.ok) { console.error(c(RED, `✗ OpenAGI main unreachable at ${target.url} — start it (\`openagi serve\`) or pass --remote`)); return 1; }

  const result = await applyMigration({ extracted, dataDir: resolveDataDir(), client });
  console.log(c(GREEN, `\n✓ migrated: ${result.importedMemories}/${extracted.memories.length} memories imported`)
    + (result.persona ? c(GREEN, ", persona written") : "")
    + (extracted.telegram.length ? c(GREEN, ", telegram configured") : ""));
  console.log(c(DIM, "Restart the main to apply the persona + telegram (`openagi update`, or restart the service)."));
  if (extracted.telegram.length) console.log(c(YELLOW, "If OpenClaw/Hermes is still running, stop it first — Telegram allows only one poller per bot token."));
  return 0;
}

async function cmdImessageServer(flags) {
  const { createImessageServer } = await import("../src/integrations/imessage-server.js");
  const token = flags.token ?? process.env.OPENAGI_IMESSAGE_NODE_TOKEN ?? null;
  if (!token) { console.error(c(RED, "a token is required — pass --token <secret> (the main uses the same as OPENAGI_IMESSAGE_NODE_TOKEN)")); return 1; }
  const port = Number(flags.port ?? process.env.OPENAGI_IMESSAGE_PORT ?? 43298);
  const host = flags.host ?? "0.0.0.0";
  const server = createImessageServer({ token });
  await new Promise((resolve) => server.listen(port, host, resolve));
  console.log(c(GREEN, `iMessage node service on http://${host}:${port}`));
  console.log(c(DIM, `On the main, set OPENAGI_IMESSAGE_NODE=http://<this-host>:${port} and OPENAGI_IMESSAGE_NODE_TOKEN=<the token>, then restart — the agent gets a search_imessages tool.`));
  console.log(c(DIM, "Requires Full Disk Access (read chat.db) for this process. Ctrl-C to stop."));
  await new Promise(() => {}); // run until killed
}

async function cmdImessageSearch(positional, flags) {
  const { searchMessages } = await import("../src/integrations/imessage-bridge.js");
  const query = positional.join(" ").trim();
  let rows;
  try {
    rows = await searchMessages(undefined, { query, handle: flags.from, days: flags.days ? Number(flags.days) : null, limit: flags.limit ? Number(flags.limit) : 30 });
  } catch (error) {
    console.error(c(RED, `✗ ${/too large|cantopen|unable to open/i.test(error.message) ? "can't read chat.db — grant Full Disk Access to this process" : error.message}`));
    return 1;
  }
  if (flags.json) { console.log(JSON.stringify(rows, null, 2)); return 0; }
  if (!rows.length) { console.log(c(DIM, "no matching messages")); return 0; }
  for (const m of rows) {
    const who = m.fromMe ? c(GREEN, "me →") : c(BOLD, `${m.handle} →`);
    const when = m.date ? c(DIM, m.date.slice(0, 16).replace("T", " ")) : "";
    console.log(`${when} ${who} ${m.text.replace(/\s+/g, " ").slice(0, 200)}`);
  }
  return 0;
}

async function cmdImessageBridge(flags) {
  const { client, target } = makeClient(flags);
  if (!target.remote && !flags.remote) {
    console.log(c(DIM, "Bridging to the LOCAL daemon. For the main+nodes setup, `openagi pair <main>` first or pass --remote."));
  }
  // Verify the main is reachable before we start polling chat.db.
  const health = await client.health();
  if (!health.ok) { console.error(c(RED, `✗ main unreachable at ${target.url} — ${health.error ?? "HTTP " + health.status}`)); return 1; }

  const { IMessageBridge } = await import("../src/integrations/imessage-bridge.js");
  const allowFrom = flags.allow ? String(flags.allow).split(",").map((s) => s.trim()).filter(Boolean) : [];
  const allowChats = flags.allowChat ? String(flags.allowChat).split(",").map((s) => s.trim()).filter(Boolean) : [];
  const respondMode = flags.respond ?? (allowFrom.length || allowChats.length ? "allow" : "all");
  const captureMode = flags.capture ?? "none";
  const bridge = new IMessageBridge({
    client, allowFrom, allowChats, respondMode, captureMode, trigger: flags.trigger,
    onEvent: (e) => {
      if (e.kind === "relayed") console.log(c(GREEN, `↔ ${e.handle}: `) + c(DIM, `"${e.in}" → "${e.out}"`));
      else if (e.kind === "captured") console.log(c(DIM, `· saved to memory — ${e.handle}: "${e.in}"`));
      else if (e.kind && e.error) console.error(c(YELLOW, `! ${e.kind} ${e.handle ?? ""}: ${e.error}`));
    }
  });
  console.log(c(GREEN, `iMessage bridge → main at ${target.url}`));
  const respondDesc = respondMode === "all" ? "everyone" : respondMode === "allow" ? `allowlist (${allowFrom.join(", ")})` : respondMode === "trigger" ? `messages containing "${flags.trigger}"` : "no one (capture-only)";
  console.log(c(DIM, `Reply to: ${respondDesc}.${captureMode !== "none" ? ` Save to memory: ${captureMode}.` : ""} Ctrl-C to stop.`));
  if (allowChats.length) console.log(c(DIM, `Group chats where anyone can invoke: ${allowChats.join(", ")}`));
  console.log(c(DIM, "Requires: Full Disk Access (read chat.db) + Automation→Messages (send) for this process."));
  bridge.start(); // default 10s, read-only-safe
  await new Promise(() => {}); // run until killed
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

// Show the model tiering plan: base model + which jobs run on cheaper tiers,
// with recommendations for what to set. Reads the same env the daemon uses.
async function cmdModels(flags) {
  const { loadBootEnv } = await import("../src/boot.js");
  loadBootEnv();
  const { createModelProvider, renderModelPlan } = await import("../src/index.js");
  const provider = createModelProvider();
  if (!provider.router) {
    console.log(c(DIM, "No LLM provider configured (deterministic mode). Set OPENAI_API_KEY or ANTHROPIC_API_KEY to enable tiering."));
    return 0;
  }
  const providerName = provider.constructor.name === "AnthropicProvider" ? "anthropic" : "openai";
  if (flags.json) {
    console.log(JSON.stringify({ provider: providerName, models: provider.router.tierModels(), tasks: provider.router.describe() }, null, 2));
    return 0;
  }
  console.log(renderModelPlan(provider.router, { provider: providerName }));
  return 0;
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
  openagi migrate <openclaw|hermes> [--from D] [--dry-run]
                              import another agent's persona, memory + telegram
  openagi tick                fire a scheduler tick
  openagi models              show the model tiering plan + savings tips

${c(BOLD, "Turn this device into a node of a remote main:")}
  openagi pair <main-url> [--token T]    save the main as this device's target
  openagi unpair                         forget it
  openagi imessage-bridge [opts]         (macOS) relay incoming iMessages to the
                                         main and text its replies back. Opts:
                                         --respond all|allow|trigger|none
                                         --allow h1,h2   (sender allowlist)
                                         --allow-chat c1,c2  (group chats where
                                                          anyone can invoke)
                                         --trigger word  (reply only on a word)
                                         --capture none|allow|all  (→ memory)
  openagi imessage-search <query>        (macOS) search iMessage history
                                         [--from h] [--days N] [--limit N]
  openagi imessage-server --token T      (macOS) serve iMessage search to a
                                         remote main (gives it search_imessages)

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
      case "migrate": return await cmdMigrate(positional, flags);
      case "imessage-bridge": return await cmdImessageBridge(flags);
      case "imessage-search": return await cmdImessageSearch(positional, flags);
      case "imessage-server": return await cmdImessageServer(flags);
      case "tick": return await cmdTick(flags);
      case "models": return await cmdModels(flags);
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
