import path from "node:path";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";
import { loadEnvFile } from "../src/file-utils.js";
import { resolveDataDir, _resetDataDirCache } from "../src/data-dir.js";

// A bootstrap .env in the cwd may itself set OPENAGI_DATA_DIR, so it MUST be
// loaded before the data dir is resolved (resolveDataDir memoizes its result).
// Reset the cache first in case an import already resolved it, then resolve and
// load the canonical <dataDir>/.env for the remaining keys (loadEnvFile is
// first-wins, so the bootstrap file stays authoritative for OPENAGI_DATA_DIR).
loadEnvFile(".env");
_resetDataDirCache();
const dataDir = resolveDataDir();
loadEnvFile(path.join(dataDir, ".env"));

const port = Number.parseInt(process.env.PORT ?? "43210", 10);
const host = process.env.HOST ?? "127.0.0.1";
const runtime = createDurableRuntime({ dataDir });
const app = createHostedInterface(runtime, { host, port });
const address = await app.listen();

console.log(`OpenAGI ABI interface listening at ${address.url}`);
console.log("GET /health, GET /memory, GET /agents, GET /cron, GET /mcp, POST /ingest, POST /tick");
