import fs from "node:fs";
import path from "node:path";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";
import { loadEnvFile } from "../src/file-utils.js";
import { resolveDataDir, _resetDataDirCache } from "../src/data-dir.js";

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

// A cwd .env may set OPENAGI_DATA_DIR, which must be known BEFORE the data dir
// is resolved (resolveDataDir memoizes). But we must NOT bulk-load the cwd .env
// first: its blank sample entries (OPENAI_API_KEY=, EXA_API_KEY=) would shadow
// the real values in the canonical ~/.openagi/.env, since loadEnvFile is
// first-wins. So: peek only OPENAGI_DATA_DIR, resolve, load the canonical file
// (authoritative), then let the cwd .env fill any remaining gaps.
const cwdDataDir = peekEnvVar(".env", "OPENAGI_DATA_DIR");
if (cwdDataDir && !process.env.OPENAGI_DATA_DIR) process.env.OPENAGI_DATA_DIR = cwdDataDir;
_resetDataDirCache();
const dataDir = resolveDataDir();
loadEnvFile(path.join(dataDir, ".env")); // canonical — authoritative (first-wins)
loadEnvFile(".env");                       // cwd .env fills only keys the canonical didn't set

const port = Number.parseInt(process.env.PORT ?? "43210", 10);
const host = process.env.HOST ?? "127.0.0.1";
const runtime = createDurableRuntime({ dataDir });
const app = createHostedInterface(runtime, { host, port });
const address = await app.listen();

console.log(`OpenAGI ABI interface listening at ${address.url}`);
console.log("GET /health, GET /memory, GET /agents, GET /cron, GET /mcp, POST /ingest, POST /tick");
