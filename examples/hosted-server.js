import { startServer } from "../src/boot.js";

// Thin wrapper around the shared boot path so this example, the `openagi serve`
// CLI command, the systemd unit, and the Mac DaemonController all start the
// daemon identically. Kept as a stable entry point (systemd/Mac spawn this
// file directly).
const { address } = await startServer();

console.log(`OpenAGI ABI interface listening at ${address.url}`);
console.log("GET /health, GET /memory, GET /agents, GET /cron, GET /mcp, POST /ingest, POST /tick");
