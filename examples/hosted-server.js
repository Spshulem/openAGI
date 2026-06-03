import path from "node:path";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";
import { loadEnvFile } from "../src/file-utils.js";
import { resolveDataDir } from "../src/data-dir.js";

const dataDir = resolveDataDir();

// Load env in priority order — canonical data dir wins over local-dev overrides.
loadEnvFile(path.join(dataDir, ".env")); // canonical (loadEnvFile is first-wins)
loadEnvFile(".env");                      // optional local-dev override in cwd

const port = Number.parseInt(process.env.PORT ?? "43210", 10);
const host = process.env.HOST ?? "127.0.0.1";
const runtime = createDurableRuntime({ dataDir });
const app = createHostedInterface(runtime, { host, port });
const address = await app.listen();

console.log(`OpenAGI ABI interface listening at ${address.url}`);
console.log("GET /health, GET /memory, GET /agents, GET /cron, GET /mcp, POST /ingest, POST /tick");
