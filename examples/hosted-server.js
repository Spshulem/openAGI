import { createDurableRuntime, createHostedInterface } from "../src/index.js";
import { loadEnvFile } from "../src/file-utils.js";

loadEnvFile(".env");
loadEnvFile(".openagi/.env");

const port = Number.parseInt(process.env.PORT ?? "43210", 10);
const host = process.env.HOST ?? "127.0.0.1";
const dataDir = process.env.OPENAGI_DATA_DIR ?? ".openagi";
const runtime = createDurableRuntime({ dataDir });
const app = createHostedInterface(runtime, { host, port });
const address = await app.listen();

console.log(`OpenAGI ABI interface listening at ${address.url}`);
console.log("GET /health, GET /memory, GET /agents, GET /cron, GET /mcp, POST /ingest, POST /tick");
