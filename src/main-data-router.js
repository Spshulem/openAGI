import http from "node:http";
import https from "node:https";
import { pinnedRemoteOrigin } from "./node-control.js";
import { isMobileRouteAllowed } from "./mobile-node.js";

// A paired worker has its own stores for its local capabilities. They are
// never a fallback for the main's workspace. Forward the client's credential
// unchanged: the main, not the worker, decides what that client may access.
export function isMainDataRoute(method, pathname) {
  if (method === "POST" && pathname === "/nodes/enroll/exchange") return true;
  // Main authenticates the phone and selects the configured fleet computer.
  // Hardware capabilities still belong to this worker.
  return isMobileRouteAllowed(method, pathname)
    && pathname !== "/nodes/speech-token";
}

function failure(res, status, error, message) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ error, message }));
}

export function routeMainData(req, res, url, { pairing, identity, ownerAuthenticated, ownerBearerAuthenticated = false,
  allowInsecureRemote = false, timeoutMs = 15_000 } = {}) {
  if (!pairing?.remote || !isMainDataRoute(req.method, url.pathname)) return false;
  if (req.headers["x-openagi-main-hop"]) {
    failure(res, 508, "main-routing-loop", "This worker's main connection loops back to another worker.");
    return true;
  }
  let origin;
  try { origin = pinnedRemoteOrigin(pairing.remote, { allowInsecureRemote }); }
  catch {
    failure(res, 502, "main-unavailable", "The paired main's address needs attention. Local data has not been substituted.");
    return true;
  }
  const exchange = req.method === "POST" && url.pathname === "/nodes/enroll/exchange";
  const incomingToken = req.headers.authorization;
  const incomingID = req.headers["x-openagi-node-id"];
  const headers = { "content-type": "application/json", "x-openagi-main-hop": "1" };
  if (!ownerBearerAuthenticated && typeof incomingToken === "string" && incomingToken.startsWith("Bearer ") && typeof incomingID === "string") {
    headers.authorization = incomingToken;
    headers["x-openagi-node-id"] = incomingID;
  } else if (ownerAuthenticated && !exchange) {
    // The local owner's token is NOT authority on main. Use only the saved
    // upstream enrollment, preserving every restriction main places on it.
    const scoped = pairing.nodeEnrollmentConfirmed === true && pairing.ownerProxyToken;
    const token = scoped || pairing.token;
    if (!token) {
      failure(res, 502, "main-pairing-required", "This worker needs owner authorization from main for workspace access. Reconnect this worker to main using the main owner's pairing token; the phone pairing has been kept.");
      return true;
    }
    if (token) headers.authorization = `Bearer ${token}`;
    if (scoped) headers["x-openagi-node-id"] = identity?.nodeId;
  } else if (!exchange) {
    failure(res, 401, "unauthorized", "A paired client credential is required.");
    return true;
  }
  for (const key of ["accept", "if-none-match", "last-event-id"]) {
    if (typeof req.headers[key] === "string") headers[key] = req.headers[key];
  }
  const query = new URLSearchParams(url.searchParams);
  // Dashboard query tokens are local authority, just like its cookie. Only
  // the deliberate upstream credential above may leave this worker.
  query.delete("token");
  const target = new URL(url.pathname + (query.size ? `?${query}` : ""), origin);
  const transport = target.protocol === "https:" ? https : http;
  const upstream = transport.request(target, { method: req.method, headers }, (response) => {
    // SSE is deliberately quiet between events. Once its headers arrive,
    // don't turn that idle time into a false main-disconnected error.
    if (url.pathname === "/events") upstream.setTimeout(0);
    // Do not redirect credentials, copy cookies, or hide failed upstream
    // authorization behind an empty local store. Keep the existing pairing
    // intact so a worker misconfiguration cannot revoke a valid phone.
    if (!exchange && [401, 403].includes(response.statusCode)) {
      response.resume();
      failure(res, 502, "main-pairing-required", "This server is a worker. Its main has not authorized this client. Connect using the main's existing phone pairing; your current pairing has been kept.");
      return;
    }
    if (response.statusCode >= 300 && response.statusCode < 400 && response.statusCode !== 304) {
      response.resume();
      failure(res, 502, "main-unavailable", "The main redirected this request. Check its configured address.");
      return;
    }
    const responseHeaders = { "x-openagi-data-source": "main" };
    for (const key of ["content-type", "cache-control", "etag"]) {
      if (response.headers[key]) responseHeaders[key] = response.headers[key];
    }
    res.writeHead(response.statusCode, responseHeaders);
    response.on("error", () => res.destroy());
    response.pipe(res);
  });
  // Chat may run tools before sending a response; use the agent turn's
  // longer budget rather than the short workspace-read timeout.
  const slowRead = url.pathname === "/settings/models/test" || /^\/workspace\/integrations\/(linear|buildbetter)\/sync$/.test(url.pathname);
  const readTimeout = slowRead ? Math.max(timeoutMs, 90_000) : timeoutMs;
  upstream.setTimeout(url.pathname === "/message" ? Math.max(timeoutMs, 300_000) : readTimeout,
    () => upstream.destroy(new Error("main timeout")));
  upstream.on("error", () => failure(res, 502, "main-unavailable", "Couldn't reach the main agent. Your worker's local data has not been substituted."));
  res.on("close", () => upstream.destroy());
  req.on("aborted", () => upstream.destroy());
  req.on("error", () => upstream.destroy());
  let bytes = 0;
  req.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > 6 * 1024 * 1024) {
      req.unpipe(upstream);
      failure(res, 413, "request-too-large", "This request is too large.");
      upstream.destroy();
    }
  });
  req.pipe(upstream);
  return true;
}
