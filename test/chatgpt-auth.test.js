// test/chatgpt-auth.test.js
// Sign in with ChatGPT (src/chatgpt-auth.js) and the plan-billed provider
// (src/chatgpt-provider.js), against a fake OpenAI built on an injected fetch.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CHATGPT_AUTHORIZE_URL, CHATGPT_ISSUER, CHATGPT_JWKS_URL, CHATGPT_RESOURCE, CHATGPT_REVOKE_URL,
  CHATGPT_TOKEN_URL, DYNAMIC_CLIENT_ID, PLAN_SCOPE, REFRESH_SKEW_MS, PENDING_TTL_MS,
  _resetChatGPTAuthState, chatgptAuthPath, createPkcePair, ensureHostId, finishSignIn,
  getAccessToken, handleChatGPTAuthRoute, pkceChallenge, signOut, startSignIn, status
} from "../src/chatgpt-auth.js";
import { ChatGPTPlanProvider, toPlanRequestBody } from "../src/chatgpt-provider.js";

const ISSUED = "oaiapp_test123";
const FULL_SCOPE = `${PLAN_SCOPE} email offline_access openid profile resource.invoke`;
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const REDIRECT = "http://127.0.0.1:4317/auth/callback";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openagi-chatgpt-"));
}

function signIdToken(claims, { kid = "k1", key = privateKey } = {}) {
  const head = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key).toString("base64url");
  return `${head}.${body}.${sig}`;
}

function json(status, value, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

function sse(events) {
  const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

// A fake auth.openai.com + api.openai.com. `handlers` override per URL.
function fakeOpenAI({ nonceRef, scope = FULL_SCOPE, sub = "user-1", email = "owner@example.com", handlers = {} } = {}) {
  const calls = [];
  let accessCounter = 0;
  const fetchImpl = async (url, init = {}) => {
    const call = { url: String(url), init, form: null, json: null };
    if (typeof init.body === "string") {
      if (String(init.headers?.["content-type"] ?? "").includes("form")) call.form = Object.fromEntries(new URLSearchParams(init.body));
      else { try { call.json = JSON.parse(init.body); } catch { /* raw */ } }
    }
    calls.push(call);
    if (handlers[call.url]) {
      const out = await handlers[call.url](call, calls);
      if (out) return out;
    }
    if (call.url === CHATGPT_JWKS_URL) return json(200, { keys: [JWK] });
    if (call.url === CHATGPT_TOKEN_URL && call.form.grant_type === "authorization_code") {
      accessCounter += 1;
      const now = Math.floor(Date.now() / 1000);
      return json(200, {
        access_token: `access-${accessCounter}`,
        refresh_token: "refresh-1",
        id_token: signIdToken({ iss: CHATGPT_ISSUER, aud: call.form.client_id, sub, email, nonce: nonceRef.value, iat: now, exp: now + 3600 }),
        token_type: "Bearer",
        expires_in: 3600,
        scope
      });
    }
    if (call.url === CHATGPT_TOKEN_URL && call.form.grant_type === "refresh_token") {
      accessCounter += 1;
      return json(200, { access_token: `access-${accessCounter}`, refresh_token: `refresh-${accessCounter}`, token_type: "Bearer", expires_in: 3600, scope });
    }
    if (call.url === CHATGPT_REVOKE_URL) return new Response("", { status: 200 });
    return json(404, { error: { message: `unexpected ${call.url}` } });
  };
  return { fetchImpl, calls };
}

async function signIn(dataDir, opts = {}) {
  const nonceRef = { value: null };
  const fake = fakeOpenAI({ nonceRef, ...opts });
  const { authorizeUrl, state } = startSignIn({ dataDir, redirectUri: REDIRECT });
  nonceRef.value = new URL(authorizeUrl).searchParams.get("nonce");
  const result = await finishSignIn({ dataDir, code: "code-1", state, clientId: ISSUED, fetchImpl: fake.fetchImpl });
  return { ...fake, result, authorizeUrl, nonceRef };
}

beforeEach(() => _resetChatGPTAuthState());

test("PKCE challenge is base64url(SHA-256(verifier)) without padding", () => {
  const { verifier, challenge } = createPkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.equal(challenge, crypto.createHash("sha256").update(verifier).digest("base64url"));
  assert.ok(!challenge.includes("="));
  // RFC 7636 appendix B test vector.
  assert.equal(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("authorize URL carries the documented parameters for a first registration", () => {
  const dataDir = tmpDir();
  const { authorizeUrl } = startSignIn({ dataDir, redirectUri: REDIRECT });
  const url = new URL(authorizeUrl);
  assert.equal(`${url.origin}${url.pathname}`, CHATGPT_AUTHORIZE_URL);
  const p = url.searchParams;
  assert.equal(p.get("client_id"), DYNAMIC_CLIENT_ID);
  assert.equal(p.get("agent_name_hint"), "OpenAGI");
  assert.equal(p.get("response_type"), "code");
  assert.equal(p.get("redirect_uri"), REDIRECT);
  assert.equal(p.get("scope"), `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`);
  assert.equal(p.get("resource"), CHATGPT_RESOURCE);
  assert.equal(p.get("code_challenge_method"), "S256");
  assert.ok(p.get("state") && p.get("nonce") && p.get("code_challenge"));
  assert.match(p.get("ext_agent_host_id"), /^urn:uuid:[0-9a-f-]{36}$/);
  assert.equal(p.get("ext_agent_host_id"), ensureHostId(dataDir), "host id is stable");
  assert.equal(fs.statSync(path.join(dataDir, "chatgpt-host-id")).mode & 0o777, 0o600);
});

test("redirect must be an http loopback on 127.0.0.1", () => {
  const dataDir = tmpDir();
  for (const bad of ["http://localhost:4317/auth/callback", "https://127.0.0.1:4317/auth/callback", "http://192.168.1.2:4317/auth/callback", "openagi://callback"]) {
    assert.throws(() => startSignIn({ dataDir, redirectUri: bad }), { code: "chatgpt-invalid-redirect" });
  }
});

test("sign-in stores tokens 0600; status never returns them", async () => {
  const dataDir = tmpDir();
  const { result, calls } = await signIn(dataDir);
  assert.deepEqual(result, { signedIn: true, email: "owner@example.com", expiresAt: result.expiresAt, planEnabled: true });
  const exchange = calls.find((c) => c.url === CHATGPT_TOKEN_URL);
  assert.equal(exchange.form.client_id, ISSUED);
  assert.equal(exchange.form.redirect_uri, REDIRECT);
  assert.equal(exchange.form.resource, CHATGPT_RESOURCE);
  assert.ok(exchange.form.code_verifier);
  assert.equal(fs.statSync(chatgptAuthPath(dataDir)).mode & 0o777, 0o600);
  const stored = JSON.parse(fs.readFileSync(chatgptAuthPath(dataDir), "utf8"));
  assert.equal(stored.clientId, ISSUED);
  assert.equal(stored.planScopeGranted, true);
  const shown = JSON.stringify(status({ dataDir }));
  for (const secret of [stored.accessToken, stored.refreshToken, stored.idToken]) assert.ok(!shown.includes(secret));
});

test("missing plan scope: signed in but plan disabled", async () => {
  const dataDir = tmpDir();
  const { result } = await signIn(dataDir, { scope: "openid profile email offline_access" });
  assert.equal(result.signedIn, true);
  assert.equal(result.planEnabled, false);
  assert.equal(new ChatGPTPlanProvider({ dataDir }).isConfigured(), false);
});

test("state mismatch and reuse are rejected", async () => {
  const dataDir = tmpDir();
  const nonceRef = { value: null };
  const { fetchImpl, calls } = fakeOpenAI({ nonceRef });
  startSignIn({ dataDir, redirectUri: REDIRECT });
  await assert.rejects(finishSignIn({ dataDir, code: "c", state: "forged", clientId: ISSUED, fetchImpl }), { code: "chatgpt-state-mismatch" });
  assert.equal(calls.length, 0, "no code exchange for an unverified callback");

  const { authorizeUrl, state } = startSignIn({ dataDir, redirectUri: REDIRECT });
  nonceRef.value = new URL(authorizeUrl).searchParams.get("nonce");
  await finishSignIn({ dataDir, code: "c", state, clientId: ISSUED, fetchImpl });
  await assert.rejects(finishSignIn({ dataDir, code: "c", state, clientId: ISSUED, fetchImpl }), { code: "chatgpt-state-mismatch" });
});

test("expired pending state is rejected", async () => {
  const dataDir = tmpDir();
  const { fetchImpl, calls } = fakeOpenAI({ nonceRef: { value: null } });
  const t0 = Date.now();
  const { state } = startSignIn({ dataDir, redirectUri: REDIRECT, now: t0 });
  await assert.rejects(finishSignIn({ dataDir, code: "c", state, clientId: ISSUED, fetchImpl, now: t0 + PENDING_TTL_MS + 1 }), { code: "chatgpt-state-expired" });
  assert.equal(calls.length, 0);
});

test("ID token with a wrong nonce or bad signature is rejected", async () => {
  const dataDir = tmpDir();
  const { fetchImpl } = fakeOpenAI({ nonceRef: { value: "not-the-nonce" } });
  const { state } = startSignIn({ dataDir, redirectUri: REDIRECT });
  await assert.rejects(finishSignIn({ dataDir, code: "c", state, clientId: ISSUED, fetchImpl }), { code: "chatgpt-id-token-invalid" });
  assert.equal(fs.existsSync(chatgptAuthPath(dataDir)), false);

  const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const nonceRef = { value: null };
  const forged = fakeOpenAI({ nonceRef, handlers: {
    [CHATGPT_TOKEN_URL]: (call) => {
      const now = Math.floor(Date.now() / 1000);
      return json(200, { access_token: "a", refresh_token: "r", expires_in: 3600, scope: FULL_SCOPE,
        id_token: signIdToken({ iss: CHATGPT_ISSUER, aud: call.form.client_id, sub: "x", nonce: nonceRef.value, iat: now, exp: now + 60 }, { key: other }) });
    }
  } });
  const second = startSignIn({ dataDir, redirectUri: REDIRECT });
  nonceRef.value = new URL(second.authorizeUrl).searchParams.get("nonce");
  await assert.rejects(finishSignIn({ dataDir, code: "c", state: second.state, clientId: ISSUED, fetchImpl: forged.fetchImpl }), /bad signature/);
});

test("new registration without an issued client_id is incomplete", async () => {
  const dataDir = tmpDir();
  const { fetchImpl } = fakeOpenAI({ nonceRef: { value: null } });
  const { state } = startSignIn({ dataDir, redirectUri: REDIRECT });
  await assert.rejects(finishSignIn({ dataDir, code: "c", state, fetchImpl }), { code: "chatgpt-registration-incomplete" });
});

test("later sign-in reuses the issued client and omits agent_name_hint", async () => {
  const dataDir = tmpDir();
  await signIn(dataDir);
  await signOut({ dataDir, fetchImpl: fakeOpenAI({ nonceRef: { value: null } }).fetchImpl });
  const p = new URL(startSignIn({ dataDir, redirectUri: "http://127.0.0.1:5555/auth/callback" }).authorizeUrl).searchParams;
  assert.equal(p.get("client_id"), ISSUED);
  assert.equal(p.get("agent_name_hint"), null);
  assert.equal(p.get("login_hint"), "owner@example.com");
  assert.equal(p.get("id_token_hint"), null, "no id_token_hint after sign-out");
});

test("access token refreshes ~2 minutes before expiry, rotating the refresh token", async () => {
  const dataDir = tmpDir();
  const { fetchImpl, calls } = await signIn(dataDir);
  const stored = JSON.parse(fs.readFileSync(chatgptAuthPath(dataDir), "utf8"));
  assert.equal(await getAccessToken({ dataDir, fetchImpl, now: stored.expiresAt - REFRESH_SKEW_MS - 1000 }), "access-1");
  assert.equal(calls.filter((c) => c.form?.grant_type === "refresh_token").length, 0);

  const token = await getAccessToken({ dataDir, fetchImpl, now: stored.expiresAt - REFRESH_SKEW_MS + 1000 });
  assert.equal(token, "access-2");
  const refresh = calls.find((c) => c.form?.grant_type === "refresh_token");
  assert.deepEqual(refresh.form, { grant_type: "refresh_token", client_id: ISSUED, refresh_token: "refresh-1", resource: CHATGPT_RESOURCE });
  const after = JSON.parse(fs.readFileSync(chatgptAuthPath(dataDir), "utf8"));
  assert.equal(after.refreshToken, "refresh-2");
  assert.equal(fs.statSync(chatgptAuthPath(dataDir)).mode & 0o777, 0o600);
});

test("dead refresh token clears tokens and reports signed out", async () => {
  const dataDir = tmpDir();
  const { nonceRef } = await signIn(dataDir);
  const dead = fakeOpenAI({ nonceRef, handlers: { [CHATGPT_TOKEN_URL]: () => json(400, { error: "invalid_grant" }) } });
  await assert.rejects(getAccessToken({ dataDir, fetchImpl: dead.fetchImpl, forceRefresh: true }), { code: "chatgpt-signed-out" });
  assert.equal(fs.existsSync(chatgptAuthPath(dataDir)), false);
});

test("sign-out revokes the refresh token and deletes the file", async () => {
  const dataDir = tmpDir();
  const { fetchImpl, calls } = await signIn(dataDir);
  const out = await signOut({ dataDir, fetchImpl });
  assert.equal(out.revoked, true);
  const revoke = calls.find((c) => c.url === CHATGPT_REVOKE_URL);
  assert.deepEqual(revoke.form, { token: "refresh-1", token_type_hint: "refresh_token", client_id: ISSUED });
  assert.equal(fs.existsSync(chatgptAuthPath(dataDir)), false);
  assert.deepEqual(status({ dataDir }), { signedIn: false, email: null, expiresAt: null, planEnabled: false });
});

function fakeRes() {
  return {
    status: null, headers: null, body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = String(body ?? ""); }
  };
}
const sendJson = (res, status, value) => { res.status = status; res.json = value; };

test("route handler shapes", async () => {
  const dataDir = tmpDir();
  const nonceRef = { value: null };
  const { fetchImpl } = fakeOpenAI({ nonceRef });
  const req = { headers: { host: "127.0.0.1:4317" }, socket: { localPort: 4317 } };
  const route = (method, pathname, extra = {}) => {
    const res = fakeRes();
    const url = new URL(`http://127.0.0.1:4317${pathname}`);
    return handleChatGPTAuthRoute({ method, pathname: url.pathname, url, req, res, dataDir, sendJson, readJson: async () => extra.body ?? {}, onSignedIn: extra.onSignedIn, fetchImpl })
      .then((handled) => ({ handled, res }));
  };

  assert.equal((await route("GET", "/health")).handled, false);

  const start = await route("POST", "/auth/chatgpt/start");
  assert.equal(start.handled, true);
  assert.equal(start.res.status, 200);
  assert.ok(start.res.json.authorizeUrl.startsWith(CHATGPT_AUTHORIZE_URL));
  assert.equal(start.res.json.redirectUri, "http://127.0.0.1:4317/auth/callback");
  const authorize = new URL(start.res.json.authorizeUrl).searchParams;
  nonceRef.value = authorize.get("nonce");

  const bad = await route("POST", "/auth/chatgpt/start", { body: { redirectUri: "http://localhost:1/x" } });
  assert.equal(bad.res.status, 400);
  assert.equal(bad.res.json.error, "chatgpt-invalid-redirect");

  let signedIn = null;
  const cb = await route("GET", `/auth/callback?code=c1&state=${authorize.get("state")}&client_id=${ISSUED}`, { onSignedIn: (s) => { signedIn = s; } });
  assert.equal(cb.res.status, 200);
  assert.match(cb.res.headers["content-type"], /text\/html/);
  assert.match(cb.res.body, /Signed in\. You can close this window\./);
  assert.equal(signedIn.signedIn, true);

  const replay = await route("GET", `/auth/chatgpt/callback?code=c1&state=${authorize.get("state")}`);
  assert.equal(replay.res.status, 400);
  assert.match(replay.res.body, /Sign-in failed/);

  const st = await route("GET", "/auth/chatgpt/status");
  assert.equal(st.res.json.signedIn, true);
  assert.equal(st.res.json.email, "owner@example.com");
  assert.equal("accessToken" in st.res.json, false);

  const so = await route("POST", "/auth/chatgpt/signout");
  assert.equal(so.res.json.signedOut, true);
  assert.equal((await route("GET", "/auth/chatgpt/status")).res.json.signedIn, false);
});

const completed = (text) => ({ type: "response.completed", response: { id: "r1", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], usage: { input_tokens: 1, output_tokens: 1 } } });

test("provider sends store:false, stream:true with the ChatGPT bearer token", async () => {
  const dataDir = tmpDir();
  const { fetchImpl, calls } = await signIn(dataDir, { handlers: {
    "https://api.openai.com/v1/responses": () => sse([{ type: "response.output_text.delta", delta: "Hello" }, completed("Hello")])
  } });
  const provider = new ChatGPTPlanProvider({ dataDir, fetchImpl, model: "gpt-test" });
  assert.equal(provider.isConfigured(), true);
  const out = await provider.generate({ input: "hi", agent: { name: "t" } });
  assert.equal(out.text, "Hello");
  assert.equal(out.provider, "chatgpt");
  const call = calls.find((c) => c.url === "https://api.openai.com/v1/responses");
  assert.equal(call.init.headers.authorization, "Bearer access-1");
  assert.equal(call.json.store, false);
  assert.equal(call.json.stream, true);
  assert.equal(call.json.model, "gpt-test");
});

test("tools are grouped in a namespace and unsupported fields are dropped", () => {
  const body = toPlanRequestBody({
    model: "m", temperature: 0.2, previous_response_id: "x", metadata: {},
    tools: [{ type: "function", name: "remember", parameters: {} }, { type: "web_search" }],
    input: [{ type: "function_call", call_id: "c", name: "remember", arguments: "{}" }]
  });
  assert.equal(body.temperature, undefined);
  assert.equal(body.previous_response_id, undefined);
  assert.equal(body.metadata, undefined);
  assert.deepEqual(body.tools[0], { type: "web_search" });
  assert.equal(body.tools[1].type, "namespace");
  assert.equal(body.tools[1].tools[0].name, "remember");
  assert.equal(body.input[0].namespace, "openagi");
});

test("401 refreshes once and retries; a second 401 is chatgpt-signed-out", async () => {
  const dataDir = tmpDir();
  let responsesCalls = 0;
  const { fetchImpl, calls } = await signIn(dataDir, { handlers: {
    "https://api.openai.com/v1/responses": (call) => {
      responsesCalls += 1;
      return call.init.headers.authorization === "Bearer access-1"
        ? json(401, { detail: "token expired" })
        : sse([completed("ok")]);
    }
  } });
  const provider = new ChatGPTPlanProvider({ dataDir, fetchImpl });
  const out = await provider.generate({ input: "hi" });
  assert.equal(out.text, "ok");
  assert.equal(responsesCalls, 2);
  assert.equal(calls.filter((c) => c.form?.grant_type === "refresh_token").length, 1);

  const dataDir2 = tmpDir();
  const always401 = await signIn(dataDir2, { handlers: { "https://api.openai.com/v1/responses": () => json(401, { detail: "nope" }) } });
  const provider2 = new ChatGPTPlanProvider({ dataDir: dataDir2, fetchImpl: always401.fetchImpl });
  await assert.rejects(provider2.generate({ input: "hi" }), { code: "chatgpt-signed-out" });
});

test("429 and a mid-stream usage-limit failure map to chatgpt-plan-limit", async () => {
  const dataDir = tmpDir();
  const limited = await signIn(dataDir, { handlers: {
    "https://api.openai.com/v1/responses": () => json(429, { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } })
  } });
  const provider = new ChatGPTPlanProvider({ dataDir, fetchImpl: limited.fetchImpl });
  await assert.rejects(provider.generate({ input: "hi" }), (error) => {
    assert.equal(error.code, "chatgpt-plan-limit");
    assert.match(error.message, /usage limit/);
    return true;
  });

  const dataDir2 = tmpDir();
  const midStream = await signIn(dataDir2, { handlers: {
    "https://api.openai.com/v1/responses": () => sse([
      { type: "response.output_text.delta", delta: "Hal" },
      { type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } } }
    ])
  } });
  const provider2 = new ChatGPTPlanProvider({ dataDir: dataDir2, fetchImpl: midStream.fetchImpl });
  await assert.rejects(provider2.generate({ input: "hi", onTextDelta: () => {} }), { code: "chatgpt-plan-limit" });
});

test("provider is not configured when signed out", () => {
  const provider = new ChatGPTPlanProvider({ dataDir: tmpDir() });
  assert.equal(provider.isConfigured(), false);
});

test("returnTo openagi: callback redirects to the app on success and failure", async () => {
  const dataDir = tmpDir();
  const nonceRef = { value: null };
  const { fetchImpl } = fakeOpenAI({ nonceRef });
  const req = { headers: { host: "127.0.0.1:4317" }, socket: { localPort: 4317 } };
  const route = async (method, pathname, body) => {
    const res = fakeRes();
    const url = new URL(`http://127.0.0.1:4317${pathname}`);
    await handleChatGPTAuthRoute({ method, pathname: url.pathname, url, req, res, dataDir, sendJson, readJson: async () => body ?? {}, fetchImpl });
    return res;
  };

  const rejected = await route("POST", "/auth/chatgpt/start", { returnTo: "https://evil.example" });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.json.error, "chatgpt-invalid-return-to");

  const start = await route("POST", "/auth/chatgpt/start", { returnTo: "openagi" });
  const p = new URL(start.json.authorizeUrl).searchParams;
  nonceRef.value = p.get("nonce");
  const ok = await route("GET", `/auth/chatgpt/callback?code=c&state=${p.get("state")}&client_id=${ISSUED}`);
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.location, "openagi://chatgpt-signed-in");
  assert.match(ok.body, /http-equiv="refresh"/);

  const again = await route("POST", "/auth/chatgpt/start", { returnTo: "openagi" });
  const q = new URL(again.json.authorizeUrl).searchParams;
  const denied = await route("GET", `/auth/chatgpt/callback?error=access_denied&state=${q.get("state")}`);
  assert.equal(denied.status, 302);
  assert.equal(denied.headers.location, "openagi://chatgpt-signed-in?error=chatgpt-access-denied");

  const plain = await route("GET", "/auth/chatgpt/callback?code=c&state=unknown");
  assert.equal(plain.status, 400);
  assert.match(plain.headers["content-type"], /text\/html/);
});
