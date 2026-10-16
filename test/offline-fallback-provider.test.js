import assert from "node:assert/strict";
import test from "node:test";
import { OfflineFallbackProvider, OFFLINE_NOTE, isNetworkError } from "../src/offline-fallback-provider.js";
import { createModelProvider } from "../src/model-provider.js";
import { OnDeviceModelProvider } from "../src/on-device-provider.js";

const fake = (impl, model = "m") => ({ model, isConfigured: () => true, generate: impl });

test("network failures fall back to the on-device model and say so", async () => {
  const offline = new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo"), { code: "ENOTFOUND" }) });
  const deltas = [];
  const provider = new OfflineFallbackProvider(
    fake(async ({ onTextDelta }) => { onTextDelta({ text: "partial", reset: true }); throw offline; }),
    fake(async ({ onTextDelta }) => { onTextDelta({ text: "local", reset: false }); return { text: "local answer", model: "device" }; })
  );
  const result = await provider.generate({ input: "hi", onTextDelta: (d) => deltas.push(d) });
  assert.equal(result.text, `${OFFLINE_NOTE}\n\nlocal answer`);
  assert.equal(result.offlineFallback, true);
  assert.deepEqual(deltas.map((d) => [d.text, d.reset]), [["partial", true], ["local", true]]);
});

test("auth and quota errors do not fall back", async () => {
  let fellBack = false;
  const provider = new OfflineFallbackProvider(
    fake(async () => { throw Object.assign(new Error("401 invalid x-api-key"), { status: 401 }); }),
    fake(async () => { fellBack = true; return { text: "x" }; })
  );
  await assert.rejects(provider.generate({ input: "hi" }), /401/);
  assert.equal(fellBack, false);
});

test("isNetworkError recognizes codes, aborts and nested causes", () => {
  assert.equal(isNetworkError(Object.assign(new Error("x"), { code: "ECONNREFUSED" })), true);
  assert.equal(isNetworkError(Object.assign(new Error("x"), { name: "AbortError" })), true);
  assert.equal(isNetworkError(new Error("outer", { cause: new Error("socket hang up") })), true);
  assert.equal(isNetworkError(new Error("rate limit exceeded")), false);
});

test("mobile: auto with nothing configured is on-device; a key gets the offline fallback", () => {
  assert.ok(createModelProvider({ mobile: true, preferred: "auto", anthropic: { apiKey: "" }, openai: { apiKey: "" } }) instanceof OnDeviceModelProvider);
  const cloud = createModelProvider({ mobile: true, preferred: "auto", anthropic: { apiKey: "k" } });
  assert.ok(cloud instanceof OfflineFallbackProvider);
  assert.equal(cloud.primary.constructor.name, "AnthropicProvider");
  const desktop = createModelProvider({ mobile: false, preferred: "auto", anthropic: { apiKey: "k" } });
  assert.equal(desktop.constructor.name, "AnthropicProvider");
});
