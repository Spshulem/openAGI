import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";

// ─── fetch without WebAssembly ────────────────────────────────────────────
//
// Under nodejs-mobile with --jitless, WebAssembly is undefined, and Node's
// built-in fetch dies loading undici's llhttp parser. Request/Response/Headers
// still work there, so this sends over node:http/https and hands back a real
// Response. Request does the input normalization (URL, method, header and body
// coercion, default content-type) so we only own the wire.

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES = new Set([204, 205, 304]);
const MAX_REDIRECTS = 20;
const BODY_HEADERS = ["content-type", "content-length", "content-encoding", "content-language", "content-location"];
const CREDENTIAL_HEADERS = ["authorization", "proxy-authorization", "cookie"];

// The first touch of Headers/Request/Response loads undici, which kicks off
// an async llhttp WebAssembly compile. Without WebAssembly that promise
// rejects unhandled and kills the process even though the classes work. Swallow
// exactly that one rejection; anything else rethrows like the default handler.
let webGlobalsLoaded = false;
function loadWebGlobals() {
  if (webGlobalsLoaded) return;
  webGlobalsLoaded = true;
  if (typeof WebAssembly !== "undefined") return;
  const swallow = (reason) => {
    if (reason instanceof ReferenceError && /WebAssembly/.test(reason.message)) return stop();
    throw reason;
  };
  const stop = () => process.off("unhandledRejection", swallow);
  process.on("unhandledRejection", swallow);
  void globalThis.Response;
  setImmediate(stop);
}

function abortReason(signal) {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

function fetchFailed(cause) {
  return new TypeError("fetch failed", { cause: typeof cause === "string" ? new Error(cause) : cause });
}

function send(url, method, headers, body, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortReason(signal));
    if (url.protocol !== "http:" && url.protocol !== "https:") return reject(fetchFailed(`unsupported protocol ${url.protocol}`));
    const out = Object.fromEntries(headers);
    if (body) out["content-length"] = String(body.length);
    const req = (url.protocol === "https:" ? https : http).request(url, { method, headers: out });
    const onAbort = () => {
      req.destroy();
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    req.on("response", (res) => {
      signal.removeEventListener("abort", onAbort);
      resolve(res);
    });
    req.on("error", (err) => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.aborted ? abortReason(signal) : fetchFailed(err));
    });
    req.end(body ?? undefined);
  });
}

function toResponse(res, url, redirected, method, signal) {
  const headers = new Headers();
  for (let i = 0; i < res.rawHeaders.length; i += 2) headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
  const empty = method === "HEAD" || NULL_BODY_STATUSES.has(res.statusCode);
  if (empty) {
    res.resume();
  } else {
    // Abort after headers must still tear down the socket and error the body.
    const onAbort = () => res.destroy(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    res.once("close", () => signal.removeEventListener("abort", onAbort));
  }
  const response = new Response(empty ? null : Readable.toWeb(res), {
    status: res.statusCode,
    statusText: res.statusMessage,
    headers
  });
  // url/redirected are prototype getters; shadow them on the instance.
  Object.defineProperties(response, { url: { value: url.href }, redirected: { value: redirected } });
  return response;
}

export async function portableFetch(input, init) {
  loadWebGlobals();
  const request = new Request(input, init);
  const { signal } = request;
  if (signal.aborted) throw abortReason(signal);
  // Buffered so 307/308 can replay it.
  let body = request.body ? Buffer.from(await request.arrayBuffer()) : null;
  let method = request.method;
  let url = new URL(request.url);
  const headers = new Headers(request.headers);
  if (!headers.has("accept")) headers.set("accept", "*/*");
  if (!headers.has("user-agent")) headers.set("user-agent", "node");

  for (let hops = 0; ; hops++) {
    const res = await send(url, method, headers, body, signal);
    const location = res.headers.location;
    if (!REDIRECT_STATUSES.has(res.statusCode) || !location || request.redirect === "manual") {
      return toResponse(res, url, hops > 0, method, signal);
    }
    res.resume();
    if (request.redirect === "error") throw fetchFailed("unexpected redirect");
    if (hops >= MAX_REDIRECTS) throw fetchFailed("redirect count exceeded");
    const next = new URL(location, url);
    const toGet = res.statusCode === 303 ? method !== "HEAD" : res.statusCode <= 302 && method === "POST";
    if (toGet) {
      method = "GET";
      body = null;
      for (const name of BODY_HEADERS) headers.delete(name);
    }
    if (next.origin !== url.origin) for (const name of CREDENTIAL_HEADERS) headers.delete(name);
    url = next;
  }
}

/// Swap in portableFetch only where the built-in one can't work, unless forced.
export function installPortableFetch({ force = false } = {}) {
  loadWebGlobals();
  if (globalThis.fetch === portableFetch) return true;
  if (!force && typeof WebAssembly !== "undefined") return false;
  globalThis.fetch = portableFetch;
  return true;
}
