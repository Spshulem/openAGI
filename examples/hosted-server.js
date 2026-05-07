import path from "node:path";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";
import { loadEnvFile } from "../src/file-utils.js";

const dataDir = process.env.OPENAGI_DATA_DIR ?? ".openagi";

// Load env in priority order — explicit data dir wins over the conventional fallbacks.
loadEnvFile(path.join(dataDir, ".env"));
loadEnvFile(".env");
loadEnvFile(".openagi/.env");

const port = Number.parseInt(process.env.PORT ?? "43210", 10);
const host = process.env.HOST ?? "127.0.0.1";
const runtime = createDurableRuntime({ dataDir });
const app = createHostedInterface(runtime, { host, port });
const address = await app.listen();

console.log(`OpenAGI ABI interface listening at ${address.url}`);
console.log("GET /health, GET /memory, GET /agents, GET /cron, GET /mcp, POST /ingest, POST /tick");
