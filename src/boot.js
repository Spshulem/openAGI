import fs from "node:fs";
import path from "node:path";
import { createDurableRuntime, createHostedInterface } from "./index.js";
import { loadEnvFile } from "./file-utils.js";
import { resolveDataDir, _resetDataDirCache } from "./data-dir.js";

// Read a single var from an env file WITHOUT importing the rest of its keys.
function peekEnvVar(file, key) {
  try {
    for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const i = line.indexOf("=");
      if (i <= 0 || line.slice(0, i).trim() !== key) continue;
      let v = line.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      return v;
    }
  } catch { /* no file */ }
  return null;
}

// Resolve the data dir and load env files in the correct precedence, exactly
// as the hosted-server example does. Shared so the CLI (`openagi serve`), the
// example, and any other entry point boot identically.
//
// A cwd .env may set OPENAGI_DATA_DIR, which must be known BEFORE the data dir
// is resolved (resolveDataDir memoizes). We must NOT bulk-load the cwd .env
// first: its blank sample entries (OPENAI_API_KEY=, …) would shadow the real
// values in the canonical <dataDir>/.env, since loadEnvFile is first-wins. So:
// peek only OPENAGI_DATA_DIR, resolve, load the canonical file (authoritative),
// then let the cwd .env fill any remaining gaps.
export function loadBootEnv() {
  const cwdDataDir = peekEnvVar(".env", "OPENAGI_DATA_DIR");
  if (cwdDataDir && !process.env.OPENAGI_DATA_DIR) process.env.OPENAGI_DATA_DIR = cwdDataDir;
  _resetDataDirCache();
  const dataDir = resolveDataDir();
  loadEnvFile(path.join(dataDir, ".env")); // canonical — authoritative (first-wins)
  loadEnvFile(".env");                       // cwd .env fills only keys the canonical didn't set
  return dataDir;
}

// Boot env + start the hosted interface. Returns the listen address.
// host/port fall back to HOST/PORT env then sane defaults; callers (the CLI)
// can override. Binding to 0.0.0.0 is safe because the HTTP interface enforces
// the bearer token — but we warn so it's a deliberate choice.
export async function startServer({ host, port } = {}) {
  const dataDir = loadBootEnv();
  const resolvedHost = host ?? process.env.HOST ?? "127.0.0.1";
  const resolvedPort = Number.parseInt(String(port ?? process.env.PORT ?? "43210"), 10);

  if ((resolvedHost === "0.0.0.0" || resolvedHost === "::") && !process.env.OPENAGI_AUTH_TOKEN) {
    console.warn(
      "⚠ Binding to " + resolvedHost + " with NO OPENAGI_AUTH_TOKEN set — the dashboard and API would be\n" +
      "  reachable UNAUTHENTICATED on your network. Run `openagi setup` (or set OPENAGI_AUTH_TOKEN)\n" +
      "  before exposing OpenAGI to other devices."
    );
  }

  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { host: resolvedHost, port: resolvedPort });
  const address = await app.listen();
  return { app, runtime, address, dataDir, host: resolvedHost, port: resolvedPort };
}
