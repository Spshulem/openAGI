// Entry point for the daemon embedded in the phone apps (nodejs-mobile,
// --jitless). The native host sets OPENAGI_DATA_DIR, OPENAGI_AUTH_TOKEN,
// PORT, OPENAGI_TIME_ZONE and OPENAGI_PROVIDER, then runs this file once per
// app process; Node cannot be restarted in-process.
//
// Order matters: under --jitless there is no WebAssembly, and the first touch
// of Response/Headers/fetch loads undici, which crashes the process. The
// portable fetch must be in place before anything else is imported.
import { installPortableFetch } from "../src/portable-fetch.js";
import { installIntlFallback } from "../src/intl-fallback.js";

installPortableFetch();
installIntlFallback();
process.env.OPENAGI_PROFILE = "mobile";
if (!process.env.OPENAGI_PROVIDER) process.env.OPENAGI_PROVIDER = "on-device";

const { startServer } = await import("../src/boot.js");
const { port } = await startServer({ host: "127.0.0.1", port: Number(process.env.PORT) || 43210 });
console.log(`[openagi] embedded daemon listening on 127.0.0.1:${port}`);
