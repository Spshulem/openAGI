import { checkAuth } from "./auth.js";

const PREFIX = "/admin/providers/openai-chatgpt";

function send(res, code, value) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

async function readLoginBody(req) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text, "utf8") > 1024) throw new Error("body too large");
  }
  const value = JSON.parse(text || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 1 || value.mode !== "device") throw new Error("invalid login mode");
}

export async function handleChatGptHostOAuthRoute({ req, res, url, oauth, authToken, allowLogin = false, interactiveOwner = false }) {
  const pathname = url.pathname;
  if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) return false;
  res.setHeader("Cache-Control", "no-store");
  // Use the dashboard token as a distinct owner credential; a cookie alone is
  // insufficient for credential-bearing operations, and query tokens are out.
  const bearer = req.headers.authorization;
  if (!authToken || url.search || !bearer || !checkAuth({ headers: { authorization: bearer } }, new URL("http://localhost/"), authToken).ok) {
    send(res, 401, { error: "owner-bearer-required" });
    return true;
  }
  if (interactiveOwner !== true) {
    send(res, 403, { error: "owner-loopback-required" });
    return true;
  }
  if (!oauth) {
    send(res, 503, { error: "chatgpt-provider-unavailable" });
    return true;
  }
  // The host-owned candidate is not admitted for credential-bearing login.
  // Test harnesses may inject an explicit admission to exercise the protocol.
  if ((req.method === "GET" && pathname === `${PREFIX}/models`
    || req.method === "POST" && (pathname === `${PREFIX}/login` || /^\/admin\/providers\/openai-chatgpt\/login\/[a-f0-9]{32}\/poll$/.test(pathname)))
    && allowLogin !== true) {
    send(res, 409, { error: "chatgpt-not-qualified" });
    return true;
  }
  try {
    if (req.method === "GET" && pathname === `${PREFIX}/status`) {
      const status = await oauth.status();
      send(res, 200, { provider: "openai-chatgpt", connected: status.connected === true, authMode: "chatgpt" });
    } else if (req.method === "GET" && pathname === `${PREFIX}/models`) {
      const models = await oauth.listModels();
      send(res, 200, { models: models.filter((model) => typeof model === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(model)) });
    } else if (req.method === "POST" && pathname === `${PREFIX}/login`) {
      await readLoginBody(req);
      const login = await oauth.startDeviceLogin();
      if (!/^[a-f0-9]{32}$/.test(login.loginId) || !/^[A-Za-z0-9-]{1,128}$/.test(login.userCode)) {
        throw new Error("invalid login response");
      }
      send(res, 200, { type: "chatgptDeviceCode", loginId: login.loginId,
        userCode: login.userCode, verificationUrl: "https://auth.openai.com/codex/device" });
    } else if (req.method === "POST" && /^\/admin\/providers\/openai-chatgpt\/login\/[a-f0-9]{32}\/poll$/.test(pathname)) {
      const id = pathname.split("/")[5];
      const result = await oauth.pollDeviceLogin(id);
      const providerState = ["authorization_pending", "slow_down", "forbidden", "not_found", "upstream_unauthorized", "upstream_rate_limited", "upstream_unexpected", "transport_redirect", "transport_failed", "device_authorization_protocol", "token_exchange_transport", "token_exchange_rejected", "token_exchange_protocol"].includes(result.providerState)
        ? result.providerState : undefined;
      send(res, 200, {
        status: result.status === "connected" ? "connected" : result.status === "failed" ? "failed" : "pending",
        ...(providerState ? { providerState } : {})
      });
    } else if (req.method === "POST" && pathname === `${PREFIX}/logout`) {
      await oauth.logout();
      send(res, 200, { status: "logged-out" });
    } else {
      send(res, 404, { error: "not-found" });
    }
  } catch (error) {
    const status = error?.code === "CHATGPT_LOGIN_EXPIRED" ? 400 : 503;
    const providerState = {
      CHATGPT_STORE_UNAVAILABLE: "credential_store_unavailable",
      CHATGPT_DEVICE_AUTHORIZATION_TRANSPORT: "device_authorization_transport",
      CHATGPT_DEVICE_AUTHORIZATION_REJECTED: "device_authorization_rejected",
      CHATGPT_DEVICE_AUTHORIZATION_PROTOCOL: "device_authorization_protocol"
    }[error?.code];
    send(res, status, {
      error: status === 400 ? "login-expired" : "chatgpt-unavailable",
      ...(providerState ? { providerState } : {})
    });
  }
  return true;
}
