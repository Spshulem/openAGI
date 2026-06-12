import fs from "node:fs";
import path from "node:path";
import { resolveDataDir } from "./data-dir.js";

// Persona / identity for the main agent — the SOUL.md pattern. Drop a
// `<dataDir>/persona.md` and its content becomes the main agent's system
// prompt (prepended before the always-on ABI-loop instructions), giving the
// agent a name + voice + values that persist across sessions. Edit the file
// and restart to change it. Absent → the default "Main Agent".
//
// The agent NAME is taken from (first match): OPENAGI_AGENT_NAME env, a
// "Name:" line in the file, the first markdown heading, else "Main Agent".

export function personaPath(dataDir = resolveDataDir()) {
  return path.join(dataDir, "persona.md");
}

export function parsePersona(text) {
  if (!text || !text.trim()) return null;
  const nameLine = text.match(/^[\s>*-]*\**\s*Name\**\s*:?\**\s*[:|-]?\s*([^\n*]+)/im);
  const heading = text.match(/^#+\s*([^\n]+)/m);
  const fromEnv = (process.env.OPENAGI_AGENT_NAME ?? "").trim();
  const name = (fromEnv || nameLine?.[1]?.trim() || heading?.[1]?.trim() || "").replace(/\s*[-–—].*$/, "").trim() || "Main Agent";
  return { name, systemPrompt: text.trim() };
}

export function loadPersona(dataDir = resolveDataDir()) {
  let text;
  try { text = fs.readFileSync(personaPath(dataDir), "utf8"); } catch { return null; }
  return parsePersona(text);
}

// Apply persona.md to the runtime's main agent. Safe no-op when there's no
// file or no agent store. Returns the applied persona or null.
export function applyPersona(runtime, dataDir = resolveDataDir()) {
  const persona = loadPersona(dataDir);
  const store = runtime?.agentHost?.store;
  if (!persona || !store?.setAgent) return null;
  store.setAgent("main", { name: persona.name, systemPrompt: persona.systemPrompt, role: "root" });
  return persona;
}
