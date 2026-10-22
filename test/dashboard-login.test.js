import test from "node:test";
import assert from "node:assert/strict";
import { renderLoginPage } from "../src/dashboard-login.js";
import { buildSetCookie, checkAuth } from "../src/auth.js";

test("main login identifies the server credential and avoids the Mac copy-token trap", () => {
  const html = renderLoginPage(null, "/?tab=nodes#phone-pairing");
  assert.match(html, /this main server’s/);
  assert.match(html, /token copied from a paired Mac or phone will not work/);
  assert.match(html, /type="password"/);
  assert.match(html, /autocomplete="current-password"/);
  assert.match(html, /30 days/);
  assert.match(html, /Phone pairing is saved separately/);
  assert.doesNotMatch(html, /menubar icon/);
  assert.match(renderLoginPage(null, "/", { isWorker: true }), /Open dashboard/);
});

test("persistent browser cookie authenticates repeated visits only to the correct server token", () => {
  const cookie = buildSetCookie("test-main-owner");
  assert.match(cookie, /Max-Age=2592000/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  for (const route of ["/", "/?tab=nodes", "/?tab=today"]) {
    assert.equal(checkAuth({ headers: { cookie: cookie.split(";")[0] } }, new URL(route, "https://main.example"), "test-main-owner").ok, true);
  }
  assert.equal(checkAuth({ headers: { cookie: buildSetCookie("test-mac-owner").split(";")[0] } }, new URL("https://main.example"), "test-main-owner").ok, false);
});

test("login keeps its safe destination and escapes errors", () => {
  const html = renderLoginPage('<script>alert("test")</script>', "//outside.example");
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /name="next" value="\/"/);
  assert.match(renderLoginPage(null, '/?tab=nodes&x="oops"'), /&amp;x=&quot;oops&quot;/);
});
