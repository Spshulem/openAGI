import { saveEnv } from "./setup-wizard.js";
import { VOCALEO_ENV_KEYS, VocaleoError, publicAccount, registerVocaleoTools } from "./integrations/vocaleo.js";

// Mounted behind the existing dashboard authentication and Origin checks.
export function createVocaleoRoute({ runtime, client, dataDir }) {
  let changing = false;
  function persist(values, clear = []) {
    const previous = Object.fromEntries(VOCALEO_ENV_KEYS.map((key) => [key, process.env[key]]));
    try { saveEnv({ dataDir, values, clear }); }
    catch {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      throw new VocaleoError("Could not save Vocaleo credentials. Check the OpenAGI data directory permissions before reconnecting.", 500);
    }
    // Explicit client env injection is useful for isolated runtimes and tests.
    Object.assign(client.env, values);
    for (const key of clear) delete client.env[key];
    registerVocaleoTools(runtime, client);
  }

  return async function vocaleoRoute(method, pathname, readBody) {
    if (!pathname.startsWith("/integrations/vocaleo/")) return null;
    try {
      if (method === "GET" && pathname === "/integrations/vocaleo/status") return { status: 200, body: client.status() };
      if (method === "GET" && pathname === "/integrations/vocaleo/account") return { status: 200, body: await client.account() };
      const action = pathname.slice("/integrations/vocaleo/".length);
      if (method !== "POST" || !["request-code", "verify", "connect", "disconnect"].includes(action)) return { status: 404, body: { error: "Unknown Vocaleo setup route." } };
      if (changing) throw new VocaleoError("Another Vocaleo setup request is running. Wait for it to finish.", 409);
      changing = true;
      try {
        const body = await readBody();
        if (action === "disconnect") {
          persist({}, VOCALEO_ENV_KEYS);
          return { status: 200, body: client.status() };
        }
        if (action === "request-code") return { status: 202, body: await client.requestCode(body.phone_number) };
        let account;
        let key;
        if (action === "verify") {
          const verified = await client.verify(body.phone_number, body.code);
          account = publicAccount(verified);
          key = verified.api_key;
        } else {
          account = await client.account(body.api_key);
          key = body.api_key.trim();
        }
        if (typeof account.account_id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(account.account_id)) throw new VocaleoError("Vocaleo returned an invalid account ID.", 502);
        persist({ VOCALEO_API_KEY: key, VOCALEO_ACCOUNT_ID: account.account_id,
          ...(action === "verify" ? { VOCALEO_PHONE_NUMBER: body.phone_number.trim() } : {}) },
        action === "connect" ? ["VOCALEO_PHONE_NUMBER"] : []);
        // Never return the one-time key or SMS code to the browser/model/log.
        return { status: 200, body: { ...client.status(), account } };
      } finally { changing = false; }
    } catch (error) {
      return { status: error instanceof VocaleoError ? error.status : 400,
        body: { error: error instanceof VocaleoError ? error.message : "Could not complete Vocaleo setup. Check the entered values.", ...(error.details ?? {}) } };
    }
  };
}
