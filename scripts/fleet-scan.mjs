#!/usr/bin/env node
// One read-only fleet supervisor pass against this machine, printed caveman
// style. Always observe mode: nothing is sent to any agent.
//
//   node scripts/fleet-scan.mjs [--json] [--no-bb3] [--no-github] [--data-dir <dir>]
//
// Needs Node >= 22 (node:sqlite). Without --data-dir it uses a throwaway temp
// dir, so needs-you questions and the nudge ledger start empty each run.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FleetSupervisor } from "../src/fleet/supervisor.js";

function parseArgs(argv) {
  const args = { json: false, noBb3: false, noGithub: false, dataDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") args.json = true;
    else if (arg === "--no-bb3") args.noBb3 = true;
    else if (arg === "--no-github") args.noGithub = true;
    else if (arg === "--data-dir") args.dataDir = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown flag: ${arg}`);
  }
  return args;
}

function ageMin(iso, now) {
  const at = Date.parse(iso ?? "");
  return Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 60_000)) : null;
}

function line(text, max = 110) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function report(state, now) {
  const snap = state.snapshot;
  const out = [];
  const counts = snap.counts;
  const src = counts.sources ?? {};
  out.push(`FLEET ${new Date(snap.at).toLocaleTimeString()} · ${Math.round(snap.durationMs / 100) / 10}s · codex ${src.codex ?? 0} · claude ${src.claude ?? 0} · conductor ${src.conductor ?? 0} → ${counts.inScope} in scope`);
  out.push("");
  out.push(`NEEDS YOU (${state.questions.length})`);
  if (!state.questions.length) out.push("  nothing");
  for (const q of state.questions) out.push(`  • ${line(q.title, 100)}  [${q.options.join(" / ")}]`);
  out.push("");
  const planned = state.actions.filter((a) => a.status === "planned" || a.status === "proposed");
  out.push(`SUPERVISOR WOULD DO (${planned.length})`);
  if (!planned.length) out.push("  nothing");
  const titles = new Map(snap.threads.map((t) => [t.key, t.workspace ? `${t.workspace}` : t.title]));
  for (const a of planned) {
    const who = a.threadKey?.startsWith("infra:") ? `${a.threadKey} → manager` : (titles.get(a.threadKey) ?? a.threadKey);
    const route = a.route ?? "no route";
    out.push(`  • ${line(who, 40)} → ${a.playbook} (${route}): ${line(a.message, 80)}`);
  }
  out.push("");
  const states = Object.entries(counts.byState).sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} ${n}`);
  out.push(`STATES  ${states.join(" · ") || "none"}`);
  out.push("");
  const bb3 = snap.infra.bb3 ?? {};
  const runs = [...(bb3.runs ?? [])].sort((a, b) => b.ageSec - a.ageSec);
  const oldest = runs[0] ? `oldest ${runs[0].pr ? `#${runs[0].pr}` : "?"} ${runs[0].kind} ${Math.round(runs[0].ageSec / 60)}m` : "no runs";
  if (bb3.error === "skipped") out.push("BB3     skipped");
  else if (bb3.reachable === false) out.push(`BB3     UNREACHABLE ${line(bb3.error, 60)}`);
  else {
    const gate = bb3.gate?.state ? `${bb3.gate.state}${bb3.gate.reason ? ` (${line(bb3.gate.reason, 60)})` : ""}` : "unknown";
    out.push(`BB3     gate ${gate} · queue full ${bb3.fullQueue ?? "?"} quick ${bb3.quickQueue ?? "?"} · ${runs.length} runs, ${oldest}`);
    if (bb3.timersDead?.length) out.push(`        timers dead: ${bb3.timersDead.join(", ")}`);
  }
  const lb = snap.infra.lb ?? {};
  const lbErrors = (lb.recentErrors ?? []).map((e) => `${e.kind} ${e.count}`).join(", ");
  out.push(`LB      ${lb.healthy === true ? "healthy" : lb.healthy === false ? "UNHEALTHY" : "unknown"}${lb.detail ? ` (${line(lb.detail, 50)})` : ""}${lbErrors ? ` · errors: ${lbErrors}` : ""}`);
  const lv = snap.infra.localVerify ?? [];
  out.push(`LOCAL   ${lv.length ? lv.map((v) => `${line(v.command, 40)} ${Math.round(v.ageSec / 60)}m`).join("; ") : "no heavy local verification"}`);
  if (snap.manager) out.push(`MANAGER ${line(snap.manager.title, 40)} · ${snap.manager.live ? "live" : "not live"} · ${snap.manager.error ?? snap.manager.agentStatus}`);
  else out.push("MANAGER not found");
  for (const d of snap.infraDecisions ?? []) out.push(`        ${d.key}: ${d.action} (${line(d.reason, 80)})`);
  const errors = Object.entries(snap.sourceErrors ?? {});
  if (errors.length) out.push(`ERRORS  ${errors.map(([k, v]) => `${k}: ${line(v, 60)}`).join(" · ")}`);
  const stale = snap.threads.filter((t) => t.state === "pr-not-ready").slice(0, 12);
  if (stale.length) {
    out.push("");
    out.push("PR NOT READY");
    for (const t of stale) {
      const age = ageMin(t.lastActivityAt, now);
      out.push(`  • ${line(t.workspace ?? t.title, 28)} ${t.pr?.ref ?? ""} · ${line(t.blockers.join("; "), 60)} · idle ${age ?? "?"}m → ${t.decision?.action ?? "none"}`);
    }
  }
  return out.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("usage: node scripts/fleet-scan.mjs [--json] [--no-bb3] [--no-github] [--data-dir <dir>]");
    return;
  }
  const temp = !args.dataDir;
  const dataDir = args.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "openagi-fleet-scan-"));
  const supervisor = new FleetSupervisor({
    dataDir,
    config: { mode: "observe", enabled: false },
    skip: { bb3: args.noBb3, github: args.noGithub }
  });
  try {
    await supervisor.tick({ reason: "cli" });
    const state = supervisor.getState();
    console.log(args.json ? JSON.stringify(state, null, 2) : report(state, Date.now()));
  } finally {
    if (temp) fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`fleet-scan failed: ${error?.message ?? error}`);
  process.exitCode = 1;
});
