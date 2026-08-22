// test/sec-dashboard-xss.test.js
//
// SEC-4. The dashboard renders content the user never chose to trust — OCR'd
// screen text, iMessage bodies, fetched pages — same-origin, with the session
// cookie, next to every API including MCP register. Three defects, one
// delivery: prompt injection.
//
//   1. renderMarkdown escaped only [&<>], so a markdown link whose URL carries
//      a double quote closed href="" and opened real attributes:
//        [Open](https://x.co"style="position:fixed;inset:0"onmouseover="…)
//   2. the MCP sidebar spliced tool names into innerHTML unescaped, while the
//      identical array two functions away was escaped.
//   3. sendHtml set no Content-Security-Policy, X-Frame-Options or nosniff.
//
// These tests drive the SHIPPED code: they boot the daemon, fetch the real
// dashboard HTML, and re-execute the exact escape helper and template literals
// the browser would run.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let cachedPage = null;

async function dashboard() {
  if (cachedPage) return cachedPage;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sec4-"));
  process.env.OPENAGI_DATA_DIR = dataDir;
  process.env.OPENAGI_AUTH_TOKEN = "";
  // Without a provider key isFirstRun() is true and GET / serves the setup
  // wizard instead of the dashboard. Never used for a real call here.
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "sk-ant-not-a-real-key";
  const { _resetDataDirCache } = await import("../src/data-dir.js");
  _resetDataDirCache();
  const { createDurableRuntime, createHostedInterface } = await import("../src/index.js");
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, dataDir });
  const listened = await app.listen();
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  const res = await fetch(`${base}/`);
  const html = await res.text();
  await app.close?.();
  cachedPage = { html, headers: res.headers, script: extractScript(html) };
  return cachedPage;
}

function extractScript(html) {
  const m = html.match(/<script[^>]*>([\s\S]*)<\/script>/);
  assert.ok(m, "dashboard must contain an inline script");
  return m[1];
}

function escapeHtmlSource(script) {
  const line = script.split("\n").find((l) => l.startsWith("function escapeHtml("));
  assert.ok(line, "could not locate escapeHtml in the served dashboard");
  return line;
}

/// Rebuild the page's own escapeHtml from the served source and run it.
function shippedEscapeHtml(script) {
  return new Function(`${escapeHtmlSource(script)}; return escapeHtml;`)();
}

/// Rebuild the page's own renderMarkdown (plus safeLinkHref, the BT/FENCE
/// constants and escapeHtml it closes over) from the served source and run it.
function shippedRenderMarkdown(script) {
  const start = script.indexOf("const BT = String.fromCharCode(96);");
  assert.ok(start >= 0, "could not locate the markdown renderer preamble");
  const endMarker = script.indexOf("\n\n// Small chat composer", start);
  assert.ok(endMarker >= 0, "could not locate the end of renderMarkdown");
  const end = endMarker;
  const src = `${script.slice(start, end)}\n${escapeHtmlSource(script)}`;
  return new Function(`${src}; return renderMarkdown;`)();
}

// ── 1. escape maps ─────────────────────────────────────────────────────────

test("SEC-4: the dashboard escapeHtml escapes both quote characters", async () => {
  const { script } = await dashboard();
  const escapeHtml = shippedEscapeHtml(script);
  assert.equal(escapeHtml('a"b'), "a&quot;b", "double quote must be escaped");
  assert.equal(escapeHtml("a'b"), "a&#39;b", "single quote must be escaped");
  assert.equal(escapeHtml("<&>"), "&lt;&amp;&gt;");
  // Real payload: no raw quote survives, so it cannot terminate an attribute
  // whichever delimiter the surrounding template used.
  const out = escapeHtml(`x" onmouseover="window.PWNED=1`);
  assert.ok(!out.includes('"'), "a raw double quote survived escaping");
  assert.ok(!escapeHtml("x' onmouseover='1").includes("'"), "a raw single quote survived escaping");
});

test("SEC-4: renderMarkdown escapes quotes before it builds any attribute", async () => {
  const { script } = await dashboard();
  const renderMarkdown = shippedRenderMarkdown(script);
  const out = renderMarkdown(`he said "hi" and 'bye'`);
  assert.ok(!out.includes('"hi"'), "raw double quotes survived the escape pass");
  assert.ok(!out.includes("'bye'"), "raw single quotes survived the escape pass");
});

// ── 2. markdown links ──────────────────────────────────────────────────────

test("SEC-4: a markdown link URL cannot splice extra attributes into the anchor", async () => {
  const { script } = await dashboard();
  const renderMarkdown = shippedRenderMarkdown(script);
  const payload = `[Open](https://x.co"style="position:fixed;inset:0"onmouseover="window.PWNED=1)`;
  const out = renderMarkdown(payload);
  // The literal words may survive as inert TEXT; what must not survive is an
  // attribute — i.e. name="…" with a real quote character after the equals.
  assert.ok(!/onmouseover\s*=\s*["']/i.test(out), `injected event handler survived: ${out}`);
  assert.ok(!/\bstyle\s*=\s*["']/i.test(out), `injected style attribute survived: ${out}`);
  assert.ok((out.match(/href=/g) ?? []).length <= 1, `multiple href attributes: ${out}`);
  // Same payload with a URL the parser accepts: the quotes must be encoded
  // into the href, never left to close the attribute.
  const encoded = renderMarkdown(`[Open](https://x.co/a"onmouseover="window.PWNED=1)`);
  assert.ok(!/onmouseover\s*=\s*["']/i.test(encoded), `handler survived on a parseable URL: ${encoded}`);
});

test("SEC-4: memory correction controls encode ids and escape stored content", async () => {
  const { script } = await dashboard();
  assert.ok(script.includes('/memory/${encodeURIComponent(id)}/correct'));
  assert.ok(script.includes('${escapeHtml(m.content || "")}</textarea>'));
  assert.ok(!script.includes('${m.content}</textarea>'));
});

test("SEC-4: outcome feedback uses escaped row ids and URL encoding", async () => {
  const { script } = await dashboard();
  assert.ok(script.includes('data-outcome-feedback="${escapeHtml(o.id)}"'));
  assert.ok(script.includes('/outcomes/${encodeURIComponent(outcomeId)}/feedback'));
  assert.ok(!script.includes('data-feedback="${o.refId'));
});

test("SEC-4: renderMarkdown refuses non-http(s) link schemes", async () => {
  const { script } = await dashboard();
  const renderMarkdown = shippedRenderMarkdown(script);
  for (const url of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "vbscript:msgbox(1)"
  ]) {
    const out = renderMarkdown(`[click](${url})`);
    assert.ok(!/href="\s*(javascript|data|vbscript)/i.test(out), `dangerous scheme kept an href: ${out}`);
  }
  // …and still renders ordinary links.
  const ok = renderMarkdown("[docs](https://example.com/a?b=1)");
  assert.match(ok, /<a href="https:\/\/example\.com\/a\?b=1"/);
});

test("chat markdown renders GFM tables with inline formatting and alignment", async () => {
  const { script } = await dashboard();
  const renderMarkdown = shippedRenderMarkdown(script);
  const out = renderMarkdown([
    "| Area | Score | Assessment |",
    "|:---|---:|:---:|",
    "| **Memory quality** | 4/10 | Retrieval works |",
    "| Tasks | 6/10 | [Open docs](https://example.com/docs) |"
  ].join("\n"));

  assert.match(out, /<table class="md-table">/);
  assert.match(out, /<thead><tr><th>Area<\/th><th class="md-align-right">Score<\/th><th class="md-align-center">Assessment<\/th><\/tr><\/thead>/);
  assert.match(out, /<strong>Memory quality<\/strong>/);
  assert.match(out, /<a href="https:\/\/example\.com\/docs"/);
  assert.doesNotMatch(out, /\|:---/);
});

test("chat markdown keeps table syntax inside fenced code literal and escapes table-cell HTML", async () => {
  const { script } = await dashboard();
  const renderMarkdown = shippedRenderMarkdown(script);
  const fence = String.fromCharCode(96).repeat(3);
  const out = renderMarkdown([
    fence,
    "| not | a table |",
    "| --- | --- |",
    fence,
    "",
    "| Safe | Value |",
    "| --- | --- |",
    '| cell | <img src=x onerror="window.PWNED=1"> |'
  ].join("\n"));

  assert.equal((out.match(/<table class="md-table">/g) ?? []).length, 1);
  assert.match(out, /<pre class="md-code"><code/);
  assert.match(out, /\| not \| a table \|/);
  assert.doesNotMatch(out, /<img/i);
  assert.doesNotMatch(out, /onerror\s*=\s*["']/i);
  assert.match(out, /&lt;img src=x onerror=&quot;window\.PWNED=1&quot;&gt;/);
});

test("SEC-4: task source links use the same http(s)-only URL gate", async () => {
  const { script } = await dashboard();
  assert.match(script, /const sourceHref = t\.sourceUrl \? safeLinkHref\(t\.sourceUrl\) : null/);
  assert.doesNotMatch(
    script,
    /href="\\\$\{escapeHtml\(t\.sourceUrl\)\}/,
    "escaping an attribute does not make a javascript: URL safe to navigate"
  );
});

// ── 3. the MCP sidebar tool list ───────────────────────────────────────────

test("SEC-4: MCP tool names are escaped in the sidebar, not just the detail pane", async () => {
  const { script } = await dashboard();
  const escapeHtml = shippedEscapeHtml(script);
  const line = script.split("\n").find((l) => l.includes("li.innerHTML") && l.includes("s.tools"));
  assert.ok(line, "could not locate the MCP sidebar row template");
  const tmpl = line.slice(line.indexOf("`"), line.lastIndexOf("`") + 1);
  const render = new Function("s", "escapeHtml", `return ${tmpl};`);
  const out = render(
    { name: "srv", connected: false, tools: ['<img src=x onerror="window.PWNED=1">'] },
    escapeHtml
  );
  assert.ok(!out.includes("<img"), `unescaped tool name reached innerHTML: ${out}`);
  assert.ok(!/onerror\s*=\s*["']/.test(out), `event handler reached innerHTML: ${out}`);
});

// ── 4. response headers ────────────────────────────────────────────────────

test("SEC-4: sendHtml sets CSP, nosniff and frame-ancestors", async () => {
  const { headers } = await dashboard();
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal((headers.get("x-frame-options") ?? "").toUpperCase(), "DENY");
  const csp = headers.get("content-security-policy");
  assert.ok(csp, "no Content-Security-Policy header");
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /form-action 'self'/);
  // script-src must be nonce-based. 'unsafe-inline' would leave the injected
  // onmouseover/onerror handlers running, which is the whole attack.
  const scriptSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src"));
  assert.ok(scriptSrc, "no script-src directive");
  assert.match(scriptSrc, /'nonce-[A-Za-z0-9+/=_-]{16,}'/, `script-src is not nonce-based: ${scriptSrc}`);
  assert.ok(!scriptSrc.includes("'unsafe-inline'"), `script-src still allows inline handlers: ${scriptSrc}`);
  assert.ok(!scriptSrc.includes("'unsafe-eval'"), `script-src allows eval: ${scriptSrc}`);
});

test("SEC-4: the CSP the dashboard ships is one the dashboard can actually run under", async () => {
  const { html, headers } = await dashboard();
  const csp = headers.get("content-security-policy");
  const nonce = csp.match(/'nonce-([^']+)'/)[1];

  // Every script tag on the page must carry that exact nonce, or the page is
  // simply broken under its own policy.
  const scriptTags = html.match(/<script\b[^>]*>/g) ?? [];
  assert.ok(scriptTags.length > 0, "dashboard has no script tags?");
  for (const tag of scriptTags) {
    assert.ok(tag.includes(`nonce="${nonce}"`), `script tag missing nonce: ${tag.slice(0, 120)}`);
  }
  // A fresh request must get a different nonce (it is not a constant).
  const second = await (async () => {
    const { createDurableRuntime, createHostedInterface } = await import("../src/index.js");
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sec4b-"));
    const app = createHostedInterface(createDurableRuntime({ dataDir }), { host: "127.0.0.1", port: 0, dataDir });
    const l = await app.listen();
    const r = await fetch(`${l.url ?? `http://127.0.0.1:${l.port}`}/`);
    await r.text();
    await app.close?.();
    return r.headers.get("content-security-policy");
  })();
  assert.notEqual(second.match(/'nonce-([^']+)'/)[1], nonce, "the nonce is a constant — useless");

  // The page needs inline <style> AND style="" attributes; the policy must
  // permit them or the whole dashboard renders unstyled.
  const styleSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("style-src"));
  assert.ok(styleSrc?.includes("'unsafe-inline'"), `inline styles would be blocked: ${styleSrc}`);
  // It talks to itself over fetch + EventSource; connect-src must allow that.
  const connectSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("connect-src"));
  assert.ok(connectSrc?.includes("'self'"), `same-origin fetch would be blocked: ${connectSrc}`);
  // And nothing on the page depends on an inline event-handler attribute,
  // which a nonce-based script-src would silently kill.
  assert.equal(/\son(?:click|load|error|mouseover|focus|submit|change|input)\s*=/.test(html), false,
    "page relies on an inline event handler attribute that the CSP will block");
});

test("SEC-4: the login page is served with the same headers", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sec4-login-"));
  process.env.OPENAGI_DATA_DIR = dataDir;
  const prevToken = process.env.OPENAGI_AUTH_TOKEN;
  process.env.OPENAGI_AUTH_TOKEN = "sekrit-token-for-test";
  const { _resetDataDirCache } = await import("../src/data-dir.js");
  _resetDataDirCache();
  const { createDurableRuntime, createHostedInterface } = await import("../src/index.js");
  const app = createHostedInterface(createDurableRuntime({ dataDir }), { host: "127.0.0.1", port: 0, dataDir });
  const listened = await app.listen();
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  try {
    const res = await fetch(`${base}/`, { headers: { accept: "text/html" } });
    assert.equal(res.status, 401);
    const html = await res.text();
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.ok(res.headers.get("content-security-policy"), "login page has no CSP");
    assert.ok(!html.includes("sekrit-token-for-test"), "login page must not echo the token");
  } finally {
    await app.close?.();
    if (prevToken === undefined) delete process.env.OPENAGI_AUTH_TOKEN; else process.env.OPENAGI_AUTH_TOKEN = prevToken;
    _resetDataDirCache();
  }
});
